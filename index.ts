// Supabase Edge Function: wa-reset  (kept under this name so nothing has to be renamed)
// No WhatsApp any more. Forgot password = the user sends his username, the admin approves in the app.
//   request  (public) -> stores a reset request for the admin
//   rlist / rapprove / rreject  (admin only) -> list, approve (returns a temporary password) or reject
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
const out = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => out({ error: m }, s);

// same login email the app builds in sbMail()
const mailOf = async (u: string) => {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("u:" + u.trim().toLowerCase())));
  return "dseero2007+u" + [...h].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("") + "@gmail.com";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let b: any; try { b = await req.json(); } catch { return err("Bad request"); }

  if (b.action === "request") {
    const username = String(b.username || "").trim();
    if (!username) return err("Enter your username.");
    const email = await mailOf(username);
    const { data: lk } = await sb.auth.admin.generateLink({ type: "recovery", email }); // finds the user, sends nothing
    const user = lk?.user;
    if (user) {
      await sb.from("reset_requests").upsert({
        email, user_id: user.id, username: user.user_metadata?.username || username,
        phone: user.user_metadata?.phone || "", created_at: new Date().toISOString(),
      });
    }
    return out({ ok: true }); // same answer whether or not the username exists
  }

  if (["rlist", "rapprove", "rreject"].includes(b.action)) {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: me } = await sb.auth.getUser(jwt);
    if (!me?.user || me.user.email !== await mailOf("modather")) return err("Admins only.", 403);
    if (b.action === "rlist") {
      const { data } = await sb.from("reset_requests").select("email,username,phone,created_at").order("created_at", { ascending: false });
      return out({ requests: data ?? [] });
    }
    const em = String(b.email || "");
    const { data: row } = await sb.from("reset_requests").select("*").eq("email", em).maybeSingle();
    if (!row) return err("Request not found.", 404);
    if (b.action === "rreject") { await sb.from("reset_requests").delete().eq("email", em); return out({ ok: true }); }
    const abc = "abcdefghjkmnpqrstuvwxyz23456789";
    const temp = Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => abc[x % abc.length]).join("");
    const { data: tu } = await sb.auth.admin.getUserById(row.user_id);
    const { error } = await sb.auth.admin.updateUserById(row.user_id, { password: temp, user_metadata: { ...(tu?.user?.user_metadata || {}), rec: "" } });
    if (error) return err("Could not reset the password.", 500);
    await sb.from("reset_requests").delete().eq("email", em);
    return out({ temp, username: row.username });
  }
  return err("Bad request");
});
