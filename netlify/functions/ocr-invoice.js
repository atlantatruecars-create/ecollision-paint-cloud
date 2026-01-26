// netlify/functions/ocr-invoice.js

exports.handler = async (event) => {
  // Allow POST only
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
      headers: { "Content-Type": "application/json" },
    };
  }

  try {
    const apiKey = process.env.GCV_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing GCV_API_KEY env var" }),
        headers: { "Content-Type": "application/json" },
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { imageBase64, imageUrl } = body;

    if (!imageBase64 && !imageUrl) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "imageBase64 or imageUrl required" }),
        headers: { "Content-Type": "application/json" },
      };
    }

    // Strip base64 header if present
    let contentBase64 = null;
    if (imageBase64) {
      const parts = imageBase64.split(",");
      contentBase64 = parts.length > 1 ? parts[1] : parts[0];
    }

    const visionPayload = {
      requests: [
        {
          image: imageUrl
            ? { source: { imageUri: imageUrl } }
            : { content: contentBase64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        },
      ],
    };

    const visionRes = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(visionPayload),
      }
    );

    if (!visionRes.ok) {
      const err = await visionRes.text();
      throw new Error(`Vision API error ${visionRes.status}: ${err}`);
    }

    const visionData = await visionRes.json();
    const text =
      visionData.responses?.[0]?.fullTextAnnotation?.text || "";

    if (!text) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          supplier: "",
          invoice_number: "",
          cost: null,
          notes: "No text detected",
        }),
        headers: { "Content-Type": "application/json" },
      };
    }

    const parsed = {
      supplier: extractSupplier(text),
      invoice_number: extractInvoiceNumber(text),
      cost: extractTotal(text),
      // Notes: structured paint items first, then fallback
      notes:
        formatPaintItems(text) ||
        extractPaintLinesFallback(text) ||
        text.slice(0, 800),
    };

    return {
      statusCode: 200,
      body: JSON.stringify(parsed),
      headers: { "Content-Type": "application/json" },
    };
  } catch (err) {
    console.error("OCR ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server error",
        details: String(err),
      }),
      headers: { "Content-Type": "application/json" },
    };
  }
};

/* ===============================
   INVOICE PARSING HELPERS
   =============================== */

function extractSupplier(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const raw = lines[i];
    const lower = raw.toLowerCase();

    if (
      lower.includes("invoice") ||
      lower.includes("bill to") ||
      lower.includes("ship to") ||
      lower.includes("date") ||
      lower.includes("total") ||
      lower.includes("www") ||
      lower.includes(".com") ||
      lower.includes("ga")
    )
      continue;

    const letters = (raw.match(/[A-Za-z]/g) || []).length;
    if (letters >= 4) return raw;
  }

  return "";
}

function extractInvoiceNumber(text) {
  const m = text.match(/Invoice\s*#\s*([0-9]+)/i);
  if (m) return m[1];

  const fallback = text
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().includes("invoice"));

  return fallback || "";
}

function extractTotal(text) {
  const m = text.match(/Total\s*\$?\s*([\d,]+\.\d{2})/i);
  if (m) return parseFloat(m[1].replace(/,/g, ""));

  const alt = text.match(
    /(amount due|balance due)\s*\$?\s*([\d,]+\.\d{2})/i
  );
  if (alt) return parseFloat(alt[2].replace(/,/g, ""));

  return null;
}

/**
 * Main: parse all real paint line items and return pretty lines like:
 *   GM/CHEV | WA8624 | WHITE 85-26 | 0.5 Pint
 */
function formatPaintItems(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const parsedItems = [];

  for (const line of lines) {
    // Only handle lines that look like REAL paint items:
    // must contain "Paint", a number, and a unit word
    if (!/paint/i.test(line)) continue;
    if (!/\d/.test(line)) continue; // no quantity? skip
    if (!/(pint|quart|gallon|pt|qt|gal)/i.test(line)) continue;

    const parsed = parsePaintLineFlexible(line);
    if (parsed && parsed.code) {
      parsedItems.push(
        `${parsed.make} | ${parsed.code} | ${parsed.color} | ${parsed.qty} ${parsed.unit}`
      );
    }
  }

  if (parsedItems.length === 0) return "";
  return parsedItems.join("\n");
}

/**
 * Flexible parser for lines like:
 *  "Paint 0.5 Pint MIPA GM/CHEV WA8624 WHITE 85-26"
 *  "Paint 1 Pint GM/CHEV WA8624 WHITE"
 *  "Paint 1 Pint WA8624 GM/CHEV WHITE"
 */
function parsePaintLineFlexible(line) {
  const norm = line.replace(/\s+/g, " ").trim();
  if (!/paint/i.test(norm)) return null;

  const tokens = norm.split(" ");

  // 0) Find "Paint" index
  const pIdx = tokens.findIndex(
    (t) => t.toLowerCase() === "paint"
  );
  const startIdx = pIdx === -1 ? 0 : pIdx;

  // 1) Find quantity (first numeric token after "Paint")
  let qtyIdx = -1;
  let qty = null;
  for (let i = startIdx + 1; i < Math.min(tokens.length, startIdx + 6); i++) {
    const cleaned = tokens[i].replace(/[^\d.]/g, "");
    if (!cleaned) continue;
    const num = parseFloat(cleaned);
    if (!isNaN(num)) {
      qtyIdx = i;
      qty = num;
      break;
    }
  }
  if (qtyIdx === -1) return null; // no quantity → not a real line item

  // 2) Find unit near quantity
  const unitWords = [
    "pint",
    "pints",
    "pt",
    "quart",
    "quarts",
    "qt",
    "gallon",
    "gallons",
    "gal",
  ];
  let unitIdx = -1;
  let unit = "";
  for (let i = qtyIdx + 1; i < Math.min(tokens.length, qtyIdx + 4); i++) {
    const low = tokens[i].toLowerCase();
    if (unitWords.includes(low)) {
      unitIdx = i;
      unit = tokens[i];
      break;
    }
  }
  if (!unit) return null; // must have unit

  // 3) Prefer WA-code as paint code, otherwise short code
  let codeIdx = -1;
  let code = "";

  const searchFrom = unitIdx + 1;

  // 3a) Try WAxxxx pattern first
  for (let i = searchFrom; i < tokens.length; i++) {
    if (/^wa\d{3,5}$/i.test(tokens[i])) {
      codeIdx = i;
      code = tokens[i];
      break;
    }
  }

  // 3b) If no WAxxxx, try short 2–6 char alphanumeric code (k3g, a5g, etc.)
  if (codeIdx === -1) {
    for (let i = searchFrom; i < tokens.length; i++) {
      const tok = tokens[i];
      if (/^[A-Za-z0-9]{2,6}$/.test(tok)) {
        codeIdx = i;
        code = tok;
        break;
      }
    }
  }

  // 4) Make:
  // Usually between unitIdx+1 and codeIdx, but filter out brand words like MIPA, PPG, etc.
  const brandWords = ["mipa", "ppg", "basf", "sherwin", "dupont", "spi", "standox"];
  let make = "Unknown";
  if (codeIdx !== -1 && codeIdx > unitIdx + 1) {
    const rawMakeTokens = tokens.slice(unitIdx + 1, codeIdx);
    const filtered = rawMakeTokens.filter((t) => {
      const low = t.toLowerCase();
      return !brandWords.includes(low);
    });
    if (filtered.length > 0) {
      make = filtered.join(" ");
    }
  } else if (codeIdx !== -1 && qtyIdx > startIdx + 1) {
    // e.g. "Paint GM/CHEV 0.5 Pint WA8624 White"
    const rawMakeTokens = tokens.slice(startIdx + 1, qtyIdx);
    const filtered = rawMakeTokens.filter((t) => {
      const low = t.toLowerCase();
      return !brandWords.includes(low);
    });
    if (filtered.length > 0) {
      make = filtered.join(" ");
    }
  }

  // 5) Color: everything after the code, ignoring obvious numeric price at the end
  let color = "";
  if (codeIdx !== -1 && codeIdx < tokens.length - 1) {
    let colorTokens = tokens.slice(codeIdx + 1);

    // If the last token looks like a price (nnn.nn), drop it
    const last = colorTokens[colorTokens.length - 1];
    if (/\d+\.\d{2}/.test(last)) {
      colorTokens = colorTokens.slice(0, -1);
    }

    color = colorTokens.join(" ");
  }

  const normalizedUnit = normalizeUnit(unit);

  return {
    qty: qty !== null ? qty : "",
    unit: normalizedUnit || unit || "",
    make: make || "Unknown",
    code: code || "",
    color: color || "",
  };
}

function normalizeUnit(u) {
  const l = u.toLowerCase();
  if (l.startsWith("pint") || l === "pt") return "Pint";
  if (l.startsWith("quart") || l === "qt") return "Quart";
  if (l.startsWith("gallon") || l === "gal") return "Gallon";
  return u;
}

/**
 * Very simple fallback if structured parse fails:
 * just keep any line that mentions "Paint"
 */
function extractPaintLinesFallback(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const items = [];

  for (const line of lines) {
    if (/paint/i.test(line)) {
      items.push(line);
    }
  }

  return items.join("\n");
}
