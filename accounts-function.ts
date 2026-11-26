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
let adminId: string | null = null;
const BLOCK = "876000h";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
const out = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => out({ error: m }, s);

// same login email the app builds in sbMail()
const mailOf = async (u: string) => {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("u:" + u.trim().toLowerCase())));
  return "dseero2007+u" + [...h].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("") + "@gmail.com";
};
const sha = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, "0")).join("");
const pad = (p: string) => (p.length < 6 ? p + "\u00b7mh" : p);
// the number is saved exactly as typed (only spaces and dashes are dropped); normPhone is used just to message WhatsApp
const keepPhone = (p: string) => String(p || "").replace(/[^\d+]/g, "");
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


// owner public key (same as OWNER_PUB in the app). Only the owner's private key can decrypt what this makes.
const OWNER_PUB = {"kty":"RSA","n":"vCn3dEl9RmjDSVoMJs9dhSbKRvdzctMg0UuNo1hXf0E2Sz1KcmOdQuD7NxtOtwuaZCgjcj9GBsq7ntC15Gs7_smzKjVTzi4dhzJdHwIWi_5_JB9U4IYJ1jUQibWf6PwwN5rwF-jYinLMFNT5Ldtf6Wl-nFYEFyeU6SwK6KLXfgEqv1xNAllSER7qZJjW3OKDYYAcQoGYqpmNTnV1i_JfEi8MMTgyEtJ_Mj2w3VNQRdAavXkGlzqgYDUX7p1KGFBHyJOGjOkg4AblXxqXrLDYjdG-wCiNtAPsBbkRlrcZs3YsLgl1tILhYFfi-jzd0gF9Asiyd_ZAmjaCua1Nps_cIQ","e":"AQAB"};
const escrow = async (u: string, p: string) => {
  const k = await crypto.subtle.importKey("jwk", OWNER_PUB, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, k, new TextEncoder().encode(JSON.stringify({ u, p }))));
  let s = ""; c.forEach((x) => (s += String.fromCharCode(x))); return btoa(s);
};

// No private key on the server: the list returns the encrypted copy (rec) and only the admin's browser can decrypt it.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let b: any; try { b = await req.json(); } catch { return err("Bad request"); }

  // ---------- public: sign-up request ----------
  if (b.action === "signup") {
    const username = String(b.username || "").trim(), password = String(b.password || ""), phone = keepPhone(b.phone);
    if (username.length < 2 || username.length > 40) return err("Choose a username of 2 to 40 characters.");
    if (password.length < 4) return err("Use a password of 4+ characters.");
    if (phone && phone.replace(/\D/g, "").length < 7) return err("Enter a valid phone number, or leave it empty.");
    const k = String(b.k || "");
    const { data: cu, error } = await sb.auth.admin.createUser({
      email: await mailOf(username), password: pad(password), email_confirm: true, ban_duration: BLOCK,
      user_metadata: { username, phone, rec: String(b.rec || ""), status: "pending", sk: k.length >= 16 ? await sha(k) : "" },
    });
    if (error) return err(/already|registered|exists/i.test(error.message) ? "This username is already taken." : "Could not create the request.");
    await wa(ADMIN_PHONE, T_REQUEST, username);
    return out({ ok: true, id: cu?.user?.id });
  }

  // ---------- public: the waiting page asks "approved yet?" (needs the secret only that browser knows) ----------
  if (b.action === "wait") {
    const k = String(b.k || ""), wid = String(b.id || "");
    if (k.length < 16 || !wid) return err("Bad request");
    const { data: wu } = await sb.auth.admin.getUserById(wid);
    const w = wu?.user;
    if (!w) return out({ state: "gone" });
    if (!w.user_metadata?.sk || w.user_metadata.sk !== await sha(k)) return out({ state: "none" });
    return out({ state: w.user_metadata?.status === "pending" ? "pending" : "approved" });
  }

  // ---------- any signed-in user: the admin's exercise pictures, for new accounts ----------
  const jwt0 = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (b.action === "gym_tpl") {
    const { data: gu } = await sb.auth.getUser(jwt0);
    if (!gu?.user) return err("Sign in first.", 401);
    if (!adminId) {
      const want = await mailOf(ADMIN_USERNAME);
      for (let page = 1; page <= 20 && !adminId; page++) {
        const { data: lu } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
        const f = lu?.users?.find((x: any) => String(x.email).toLowerCase() === want);
        if (f) adminId = f.id;
        if (!lu || lu.users.length < 1000) break;
      }
    }
    if (!adminId) return out({ fresh: false });
    // only brand-new accounts (nothing saved yet) get the admin's starting gym and apps
    const { data: mine } = await sb.from("hub").select("id").eq("user_id", gu.user.id).limit(1);
    if (mine && mine.length) return out({ fresh: false });
    const { data: base } = await sb.from("hub").select("id,data").eq("user_id", adminId).in("id", ["gym", "core"]);
    let gym: any = null, appGroups: any = null;
    (base || []).forEach((r: any) => { try { const o = JSON.parse(r.data?.j || "{}"); if (r.id === "gym") gym = o; if (r.id === "core") appGroups = o.appGroups; } catch (_) { /* skip */ } });
    const { data: rows } = await sb.from("hub").select("id,data").eq("user_id", adminId).like("id", "img-%");
    const imgs: Record<string, string> = {};
    (rows || []).forEach((r: any) => { try { const d = JSON.parse(r.data?.j || "{}").d; if (d) imgs[String(r.id).slice(4)] = d; } catch (_) { /* skip */ } });
    return out({ fresh: true, gym, appGroups, imgs });
  }

  // ---------- admin only ----------
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: me } = await sb.auth.getUser(jwt);
  if (!me?.user || me.user.email !== await mailOf(ADMIN_USERNAME)) return err("Admins only.", 403);

  if (b.action === "list") {
    const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) return err("Could not load accounts.", 500);
    const users = (await Promise.all(data.users.map(async (u: any) => ({
      id: u.id, username: u.user_metadata?.username || "(unknown)", phone: u.user_metadata?.phone || "",
      pending: u.user_metadata?.status === "pending", admin: u.id === me.user!.id,
      created: u.created_at, lastLogin: u.last_sign_in_at,
      rec: u.user_metadata?.rec || "",
    })))).sort((a: any, c: any) => (c.pending ? 1 : 0) - (a.pending ? 1 : 0) || a.created.localeCompare(c.created));
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
    if (ph) patch.user_metadata.phone = keepPhone(ph);
    if (np) { if (np.length < 4) return err("Use a password of 4+ characters."); patch.password = pad(np); patch.user_metadata.rec = await escrow(patch.user_metadata.username || meta.username || "", np); }
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
