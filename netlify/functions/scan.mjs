// ClearLane AI scan: reads receipt and item photos with Google's Gemini API.
// The API key stays on the server (Netlify environment variable GEMINI_API_KEY),
// so it is never visible in the app.

const PROMPT = `You read photos for a Singapore arrival declaration helper. The photos show shop receipts and/or items a traveller is about to bring into Singapore. List every distinct item you can see (merge duplicates across photos; a receipt line and a photo of the same item count once).

For each item return:
- "name": short plain name, e.g. "Eggs (2 trays)"
- "cat": one of eggs, meat, fish, fruitveg, processed, birdnest, liquor, tobacco, prohibited, medicine, goods, other
- "sub": meat -> beef|mutton|pork|poultry|other ; fish -> fish|crabprawn|oyster ; liquor -> spirits|wine|beer ; prohibited -> gum|vape|chewtob|drugs|wildlife|other ; otherwise ""
- "qty": a number in this unit: eggs = number of eggs (one tray = 30 unless the photo shows otherwise); meat, fish, fruitveg, processed, birdnest = kilograms (convert grams and litres of food, estimate from pack size if needed); liquor = litres (convert ml); tobacco = cigarette sticks (one pack = 20 unless shown); everything else = number of pieces
- "value": price in Singapore dollars as a number (estimate the SGD conversion if the receipt is in another currency), or null if unknown
- "origin": country where it was bought or produced if visible (receipt address, label), else ""
- "conf": high, medium or low
- "note": a few words if anything is uncertain, else ""

Classification rules: vapes, e-cigarettes, pods and e-liquid -> prohibited/vape. Chewing gum -> prohibited/gum (unless clearly dental or medicinal gum). Chewing tobacco, shisha, snuff, gutkha -> prohibited/chewtob. Soju and umeshu -> liquor/spirits. Sake -> liquor/wine. Snacks, biscuits, sauces, instant noodles, drinks without alcohol, milk -> processed. Clothes, shoes, electronics, cosmetics, souvenirs -> goods. Bags or items the traveller clearly already owned are not needed. Do not judge legality.

Reply with only JSON in this shape: {"items":[{"name":"","cat":"","sub":"","qty":0,"value":null,"origin":"","conf":"","note":""}]}`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default async (req) => {
  const key = process.env.GEMINI_API_KEY;
  if (req.method === "GET") return json({ ready: Boolean(key) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!key) return json({ error: "not_configured" }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const images = Array.isArray(body?.images) ? body.images.slice(0, 3) : [];
  if (!images.length) return json({ error: "no_images" }, 400);

  const parts = [{ text: PROMPT }];
  for (const im of images) {
    if (typeof im?.data !== "string" || im.data.length > 2_500_000) return json({ error: "image_too_large" }, 413);
    const type = /^image\/(jpeg|png|webp)$/.test(im.type) ? im.type : "image/jpeg";
    parts.push({ inline_data: { mime_type: type, data: im.data } });
  }

  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  // Keep "thinking" to a minimum so the answer arrives within Netlify's 10-second limit.
  const fast = /2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" };
  const call = (thinkingConfig) => {
    const generationConfig = { temperature: 0.2, response_mime_type: "application/json" };
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
      signal: AbortSignal.timeout(9000),
    });
  };

  let r, j;
  try {
    r = await call(fast);
    j = await r.json().catch(() => null);
    // If this model doesn't accept the speed setting, try once more without it.
    if (r.status === 400 && /thinking/i.test(j?.error?.message || "")) {
      r = await call(null);
      j = await r.json().catch(() => null);
    }
  } catch (e) {
    const slow = e?.name === "TimeoutError" || e?.name === "AbortError";
    return json({ error: slow ? "too_slow" : "upstream_error", message: slow ? "The AI took too long. Try one clear photo." : "Could not reach the AI service." }, 504);
  }
  if (!r.ok) {
    const msg = String(j?.error?.message || "").slice(0, 200);
    return json({ error: r.status === 429 ? "rate_limited" : "upstream_error", message: msg }, r.status === 429 ? 429 : 502);
  }

  const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  let data;
  try { data = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    try { data = JSON.parse(m ? m[0] : ""); } catch { return json({ error: "invalid_json" }, 502); }
  }
  return json({ items: Array.isArray(data?.items) ? data.items : [] });
};
