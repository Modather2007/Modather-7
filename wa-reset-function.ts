// Supabase Edge Function: wa-reset
// send   -> checks username + phone, sends a 6-digit code on WhatsApp
// verify -> checks the code, sets the new password
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const WA_TOKEN = Deno.env.get("WA_TOKEN")!;          // WhatsApp Cloud API access token
const WA_PHONE_ID = Deno.env.get("WA_PHONE_ID")!;    // WhatsApp Cloud API phone number id
const WA_TEMPLATE = Deno.env.get("WA_TEMPLATE") ?? "password_reset_code"; // approved template name
const WA_LANG = Deno.env.get("WA_LANG") ?? "en";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
const out = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => out({ error: m }, s);

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (t: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
// same login email the app builds in sbMail()
const mailOf = async (u: string) => {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("u:" + u.trim().toLowerCase())));
  return "dseero2007+u" + [...h].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("") + "@gmail.com";
};
// 01127096585 / +201127096585 / 00201127096585 -> 201127096585
const normPhone = (p: string) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "20" + d.slice(1);
  return d;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let b: any; try { b = await req.json(); } catch { return err("Bad request"); }
  const username = String(b.username || "").trim(), phone = normPhone(b.phone);
  if (!username || !phone) return err("Enter your username and phone number.");
  const email = await mailOf(username);
  const BAD = "The username or phone number does not match this account.";

  // find the account (generateLink returns the user without sending any email)
  const { data: lk, error: le } = await sb.auth.admin.generateLink({ type: "recovery", email });
  const user = lk?.user;
  if (le || !user) return err(BAD);
  if (normPhone(user.user_metadata?.phone) !== phone) return err(BAD);

  if (b.action === "send") {
    const { data: row } = await sb.from("reset_codes").select("*").eq("email", email).maybeSingle();
    if (row && Date.now() - new Date(row.sent_at).getTime() < 60_000) return err("Wait a minute before asking for a new code.", 429);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    const r = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to: phone, type: "template",
        template: {
          name: WA_TEMPLATE, language: { code: WA_LANG },
          components: [
            { type: "body", parameters: [{ type: "text", text: code }] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
          ],
        },
      }),
    });
    if (!r.ok) { console.error(await r.text()); return err("Could not send the WhatsApp message. Try again later.", 502); }
    await sb.from("reset_codes").upsert({
      email, code_hash: await sha(email + ":" + code),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), tries: 0, sent_at: new Date().toISOString(),
    });
    return out({ ok: true });
  }

  if (b.action === "verify") {
    const { data: row } = await sb.from("reset_codes").select("*").eq("email", email).maybeSingle();
    if (!row || new Date(row.expires_at).getTime() < Date.now()) return err("The code expired. Ask for a new one.");
    if (row.tries >= 5) return err("Too many wrong attempts. Ask for a new code.", 429);
    const code = String(b.code || "").trim();
    if ((await sha(email + ":" + code)) !== row.code_hash) {
      await sb.from("reset_codes").update({ tries: row.tries + 1 }).eq("email", email);
      return err("Wrong code.");
    }
    const pw = String(b.password || "");
    if (pw.length < 4) return err("Use a password of 4+ characters.");
    // same padding the app uses for short passwords
    const { error } = await sb.auth.admin.updateUserById(user.id, { password: pw.length < 6 ? pw + "\u00b7mh" : pw });
    if (error) return err("Could not change the password.", 500);
    await sb.from("reset_codes").delete().eq("email", email);
    return out({ ok: true });
  }
  return err("Bad request");
});
