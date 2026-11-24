// Supabase Edge Function: pw-reset  (v4)
// Forgot password = username only.
//   request  (public)  -> user sends username + a random secret (kept in his browser). Admin sees a request.
//   status   (public)  -> user's page asks "approved?" with the same secret. If approved, gets a one-time sign-in token.
//   rlist / rapprove / rreject (admin only, "modather")
// Approving does NOT change the password. It creates a one-time sign-in link token only the requester can pick up.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
const out = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => out({ error: m }, s);

const mailOf = async (u: string) => {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("u:" + u.trim().toLowerCase())));
  return "dseero2007+u" + [...h].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("") + "@gmail.com";
};
const sha = async (t: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, "0")).join("");

const allUsers = async () => {
  const all: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    all.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return all;
};
const findByMail = async (email: string) => (await allUsers()).find((x: any) => String(x.email).toLowerCase() === email.toLowerCase());
const setMeta = (id: string, meta: any) => sb.auth.admin.updateUserById(id, { user_metadata: meta });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let b: any; try { b = await req.json(); } catch { return err("Bad request"); }

  try {
    if (b.action === "request") {
      const username = String(b.username || "").trim(), k = String(b.k || "");
      if (!username) return err("Enter your username.");
      if (k.length < 16) return err("Bad request");
      const user = await findByMail(await mailOf(username));
      if (!user) return err("No account with this username.", 404);
      if (user.user_metadata?.status === "pending") return err("This account is still waiting for the admin to approve it.");
      const meta = { ...(user.user_metadata || {}) };
      delete meta.reset_tok; delete meta.reset_rec;
      meta.reset_req = new Date().toISOString();
      meta.reset_h = await sha(k);
      const { error } = await setMeta(user.id, meta);
      if (error) return err("Could not send the request: " + error.message, 500);
      return out({ ok: true });
    }

    if (b.action === "status") {
      const k = String(b.k || "");
      const user = await findByMail(await mailOf(String(b.username || "")));
      const meta = { ...(user?.user_metadata || {}) };
      if (!user || !k || !meta.reset_h || meta.reset_h !== await sha(k)) return out({ state: "none" });
      if (meta.reset_tok) {
        const tok = meta.reset_tok;
        delete meta.reset_tok; delete meta.reset_h; delete meta.reset_req;
        await setMeta(user.id, meta);
        return out({ state: "approved", token_hash: tok });
      }
      if (meta.reset_req) return out({ state: "pending" });
      delete meta.reset_h; await setMeta(user.id, meta);
      return out({ state: "rejected" });
    }

    if (["rlist", "rapprove", "rreject"].includes(b.action)) {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: me } = await sb.auth.getUser(jwt);
      if (!me?.user || me.user.email !== await mailOf("modather")) return err("Admins only.", 403);

      if (b.action === "rlist") {
        const requests = (await allUsers()).filter((u: any) => u.user_metadata?.reset_req)
          .map((u: any) => ({ email: u.email, username: u.user_metadata?.username || "(unknown)", phone: u.user_metadata?.phone || "", created_at: u.user_metadata.reset_req }))
          .sort((a: any, c: any) => c.created_at.localeCompare(a.created_at));
        return out({ requests });
      }

      const u = await findByMail(String(b.email || ""));
      if (!u || !u.user_metadata?.reset_req) return err("Request not found.", 404);
      const meta = { ...(u.user_metadata || {}) };
      delete meta.reset_req; delete meta.reset_rec;

      if (b.action === "rreject") {
        const { error } = await setMeta(u.id, meta); // reset_h stays so his page can say "rejected"
        if (error) return err("Could not reject: " + error.message, 500);
        return out({ ok: true });
      }

      // approve: one-time sign-in token, password untouched
      const { data: lk, error: le } = await sb.auth.admin.generateLink({ type: "magiclink", email: u.email! });
      const tok = lk?.properties?.hashed_token;
      if (le || !tok) return err("Could not approve: " + (le?.message || "no token"), 500);
      meta.reset_tok = tok;
      const { error } = await setMeta(u.id, meta);
      if (error) return err("Could not approve: " + error.message, 500);
      return out({ ok: true, username: meta.username || "" });
    }
  } catch (e) {
    console.error(e);
    return err("Server error: " + (e as Error).message, 500);
  }
  return err("Bad request");
});
