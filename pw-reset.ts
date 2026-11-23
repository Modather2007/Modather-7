// Supabase Edge Function: pw-reset  (v3, no extra table needed)
// request (public)               -> marks the account as "asked for a password reset"
// rlist / rapprove / rreject (admin only, "modather")
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
const out = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => out({ error: m }, s);

const mailOf = async (u: string) => {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("u:" + u.trim().toLowerCase())));
  return "dseero2007+u" + [...h].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("") + "@gmail.com";
};

const OWNER_PUB = {"kty":"RSA","n":"vCn3dEl9RmjDSVoMJs9dhSbKRvdzctMg0UuNo1hXf0E2Sz1KcmOdQuD7NxtOtwuaZCgjcj9GBsq7ntC15Gs7_smzKjVTzi4dhzJdHwIWi_5_JB9U4IYJ1jUQibWf6PwwN5rwF-jYinLMFNT5Ldtf6Wl-nFYEFyeU6SwK6KLXfgEqv1xNAllSER7qZJjW3OKDYYAcQoGYqpmNTnV1i_JfEi8MMTgyEtJ_Mj2w3VNQRdAavXkGlzqgYDUX7p1KGFBHyJOGjOkg4AblXxqXrLDYjdG-wCiNtAPsBbkRlrcZs3YsLgl1tILhYFfi-jzd0gF9Asiyd_ZAmjaCua1Nps_cIQ","e":"AQAB"};
const escrow = async (u: string, p: string) => {
  const k = await crypto.subtle.importKey("jwk", OWNER_PUB, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, k, new TextEncoder().encode(JSON.stringify({ u, p }))));
  let s = ""; c.forEach((x) => (s += String.fromCharCode(x))); return btoa(s);
};

const pad = (p: string) => (p.length < 6 ? p + "\u00b7mh" : p);
const OWNER_PRIV = Deno.env.get("OWNER_PRIV");
const unescrow = async (rec: string): Promise<string> => {
  if (!rec || !OWNER_PRIV) return "";
  try {
    const k = await crypto.subtle.importKey("jwk", JSON.parse(OWNER_PRIV), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
    const bin = Uint8Array.from(atob(rec.trim()), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, k, bin))).p ?? "";
  } catch (e) { console.error("unescrow failed", e); return ""; }
};

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let b: any; try { b = await req.json(); } catch { return err("Bad request"); }

  try {
    if (b.action === "request") {
      const username = String(b.username || "").trim();
      if (!username) return err("Enter your username.");
      const email = await mailOf(username);
      const user = (await allUsers()).find((x: any) => String(x.email).toLowerCase() === email.toLowerCase());
      if (!user) return err("No account with this username.", 404);
      if (user.user_metadata?.status === "pending") return err("This account is still waiting for the admin to approve it.");
      const np = String(b.password || "");
      if (np && np.length < 4) return err("Use a password of 4+ characters.");
      const add: any = { reset_req: new Date().toISOString() };
      if (np) add.reset_rec = await escrow(user.user_metadata?.username || username, np);
      else delete (user.user_metadata || {}).reset_rec;
      const { error } = await sb.auth.admin.updateUserById(user.id, { user_metadata: { ...(user.user_metadata || {}), ...add } });
      if (error) return err("Could not send the request: " + error.message, 500);
      return out({ ok: true });
    }

    if (b.action === "status") {
      const email = await mailOf(String(b.username || ""));
      const user = (await allUsers()).find((x: any) => String(x.email).toLowerCase() === email.toLowerCase());
      return out({ pending: !!user?.user_metadata?.reset_req });
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

      const em = String(b.email || "").toLowerCase();
      const u = (await allUsers()).find((x: any) => String(x.email).toLowerCase() === em && x.user_metadata?.reset_req);
      if (!u) return err("Request not found.", 404);
      const meta = { ...(u.user_metadata || {}) }; delete meta.reset_req;
      const chosenRec = meta.reset_rec; delete meta.reset_rec;

      if (b.action === "rreject") {
        const { error } = await sb.auth.admin.updateUserById(u.id, { user_metadata: meta });
        if (error) return err("Could not reject: " + error.message, 500);
        return out({ ok: true });
      }

      // he chose a new password when he asked: approving opens the account with it right away
      const chosen = chosenRec ? await unescrow(chosenRec) : "";
      if (chosen) {
        meta.rec = chosenRec;
        const { error } = await sb.auth.admin.updateUserById(u.id, { password: pad(chosen), user_metadata: meta });
        if (error) return err("Could not reset the password: " + error.message, 500);
        return out({ ok: true, username: meta.username || "" });
      }
      // fallback (old request without a password, or OWNER_PRIV not set): temporary password
      const abc = "abcdefghjkmnpqrstuvwxyz23456789";
      const temp = Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => abc[x % abc.length]).join("");
      const username = meta.username || "";
      meta.rec = await escrow(username, temp);
      const { error } = await sb.auth.admin.updateUserById(u.id, { password: temp, user_metadata: meta });
      if (error) return err("Could not reset the password: " + error.message, 500);
      return out({ temp, username });
    }
  } catch (e) {
    console.error(e);
    return err("Server error: " + (e as Error).message, 500);
  }
  return err("Bad request");
});
