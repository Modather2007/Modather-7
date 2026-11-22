// Supabase Edge Function: accounts
// Public:  signup  -> creates a BLOCKED (pending) account and tells the admin on WhatsApp
// Admin:   list | approve | update | delete   (caller must be signed in as the admin account "Modather")
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const WA_TOKEN = Deno.env.get("WA_TOKEN"), WA_PHONE_ID = Deno.env.get("WA_PHONE_ID");
const ADMIN_PHONE = Deno.env.get("ADMIN_PHONE");                       // admin WhatsApp, e.g. 201012345678
const T_REQUEST = Deno.env.get("WA_TEMPLATE_REQUEST") ?? "new_signup_request";   // body: {{1}} = username
const T_APPROVED = Deno.env.get("WA_TEMPLATE_APPROVED");               // optional, body: {{1}} = username
const WA_LANG = Deno.env.get("WA_LANG") ?? "en";
const ADMIN_USERNAME = "modather";                                      // the admin account (case-insensitive)
const BLOCK = "876000h";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
const out = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => out({ error: m }, s);

// same login email the app builds in sbMail()
const mailOf = async (u: string) => {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("u:" + u.trim().toLowerCase())));
  return "dseero2007+u" + [...h].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("") + "@gmail.com";
};
const pad = (p: string) => (p.length < 6 ? p + "\u00b7mh" : p);
const normPhone = (p: string) => { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2); if (d.startsWith("0")) d = "20" + d.slice(1); return d; };

async function wa(to: string | undefined, template: string | undefined, username: string) {
  if (!to || !template || !WA_TOKEN || !WA_PHONE_ID) return;
  try {
    await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: normPhone(to), type: "template",
        template: { name: template, language: { code: WA_LANG }, components: [{ type: "body", parameters: [{ type: "text", text: username }] }] } }),
    });
  } catch (e) { console.error(e); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let b: any; try { b = await req.json(); } catch { return err("Bad request"); }

  // ---------- public: sign-up request ----------
  if (b.action === "signup") {
    const username = String(b.username || "").trim(), password = String(b.password || ""), phone = normPhone(b.phone);
    if (username.length < 2 || username.length > 40) return err("Choose a username of 2 to 40 characters.");
    if (password.length < 4) return err("Use a password of 4+ characters.");
    if (phone.length < 10) return err("Enter the WhatsApp phone number you can receive codes on.");
    const { error } = await sb.auth.admin.createUser({
      email: await mailOf(username), password: pad(password), email_confirm: true, ban_duration: BLOCK,
      user_metadata: { username, phone, rec: String(b.rec || ""), status: "pending" },
    });
    if (error) return err(/already|registered|exists/i.test(error.message) ? "This username is already taken." : "Could not create the request.");
    await wa(ADMIN_PHONE, T_REQUEST, username);
    return out({ ok: true });
  }

  // ---------- admin only ----------
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: me } = await sb.auth.getUser(jwt);
  if (!me?.user || me.user.email !== await mailOf(ADMIN_USERNAME)) return err("Admins only.", 403);

  if (b.action === "list") {
    const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) return err("Could not load accounts.", 500);
    const users = data.users.map((u: any) => ({
      id: u.id, username: u.user_metadata?.username || "(unknown)", phone: u.user_metadata?.phone || "",
      pending: u.user_metadata?.status === "pending", admin: u.id === me.user!.id,
      created: u.created_at, lastLogin: u.last_sign_in_at,
    })).sort((a: any, c: any) => (c.pending ? 1 : 0) - (a.pending ? 1 : 0) || a.created.localeCompare(c.created));
    return out({ users });
  }

  const id = String(b.id || "");
  const { data: tu } = await sb.auth.admin.getUserById(id);
  const u = tu?.user; if (!u) return err("Account not found.", 404);
  const meta = u.user_metadata || {};

  if (b.action === "approve") {
    const { error } = await sb.auth.admin.updateUserById(id, { ban_duration: "none", user_metadata: { ...meta, status: "active" } });
    if (error) return err("Could not approve.", 500);
    await wa(meta.phone, T_APPROVED, meta.username || "");
    return out({ ok: true });
  }

  if (b.action === "update") {
    const patch: any = { user_metadata: { ...meta } };
    const nu = String(b.username ?? "").trim(), np = String(b.password ?? ""), ph = String(b.phone ?? "").trim();
    if (nu && nu !== meta.username) {
      if (id === me.user.id) return err("The admin username cannot be changed.");
      patch.email = await mailOf(nu); patch.user_metadata.username = nu; patch.user_metadata.rec = "";
    }
    if (ph) patch.user_metadata.phone = normPhone(ph);
    if (np) { if (np.length < 4) return err("Use a password of 4+ characters."); patch.password = pad(np); patch.user_metadata.rec = ""; }
    const { error } = await sb.auth.admin.updateUserById(id, patch);
    if (error) return err(/already|registered|exists/i.test(error.message) ? "This username is already taken." : "Could not save.", 400);
    return out({ ok: true });
  }

  if (b.action === "delete") {
    if (id === me.user.id) return err("You cannot delete the admin account.");
    await sb.from("hub").delete().eq("user_id", id);
    const { error } = await sb.auth.admin.deleteUser(id);
    if (error) return err("Could not delete.", 500);
    return out({ ok: true });
  }
  return err("Bad request");
});
