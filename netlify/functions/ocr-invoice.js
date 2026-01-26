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
      // Main thing you care about:
      // makes, codes, colors, quantities from each "Paint ..." line
      notes:
        formatPaintItems(text) ||
        extractLineItems(text) ||
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
 * Top-level formatter for paint lines.
 * Produces lines like:
 *   GM/Chevy | WA8624 | White | 0.5 Pint
 */
function formatPaintItems(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const parsedItems = [];

  for (const line of lines) {
    if (!/paint/i.test(line)) continue;

    const parsed = parsePaintLineFlexible(line);
    if (parsed) {
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
 *  "Paint 0.5 Pint GM/Chevy WA8624 White"
 *  "Paint 1 Pint WA8624 GM/Chevy White"
 *  "Paint 2 Quarts Chevy WA8624 Black"
 *  "Paint 1 Quart WA8624 Toyota Black"
 *
 * We only assume:
 *  - word "Paint" appears
 *  - a number quantity appears near it
 *  - a unit word (pint/quart/gallon) appears near that
 *  - a paint code appears somewhere (WA8624 or short alpha code)
 */
function parsePaintLineFlexible(line) {
  const norm = line.replace(/\s+/g, " ").trim();
  if (!/paint/i.test(norm)) return null;

  const tokens = norm.split(" ");

  const pIdx = tokens.findIndex(
    (t) => t.toLowerCase() === "paint"
  );
  const startIdx = pIdx === -1 ? 0 : pIdx;

  // 1) Find quantity (first number after "Paint")
  let qtyIdx = -1;
  let qty = null;
  for (let i = startIdx + 1; i < Math.min(tokens.length, startIdx + 6); i++) {
    const num = parseFloat(tokens[i].replace(/[^\d.]/g, ""));
    if (!isNaN(num)) {
      qtyIdx = i;
      qty = num;
      break;
    }
  }

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
  if (qtyIdx !== -1) {
    for (let i = qtyIdx + 1; i < Math.min(tokens.length, qtyIdx + 4); i++) {
      const low = tokens[i].toLowerCase();
      if (unitWords.includes(low)) {
        unitIdx = i;
        unit = tokens[i];
        break;
      }
    }
  }

  // If unit wasn't separate (like "0.5pint"), try same token as qty
  if (!unit && qtyIdx !== -1) {
    const low = tokens[qtyIdx].toLowerCase();
    for (const uw of unitWords) {
      if (low.includes(uw)) {
        unit = uw;
        break;
      }
    }
  }

  // 3) Find code: prefer WA####, otherwise a short all-caps/letters+numbers token
  let codeIdx = -1;
  let code = "";
  const codeRegexes = [
    /^wa\d{3,5}$/i, // WA8624, WA12345
    /^[a-z0-9]{2,6}$/i, // small codes like k3g, a5g
  ];

  const searchFrom =
    unitIdx !== -1 ? unitIdx + 1 :
    qtyIdx !== -1 ? qtyIdx + 1 :
    startIdx + 1;

  for (let i = searchFrom; i < tokens.length; i++) {
    const tok = tokens[i];
    for (const re of codeRegexes) {
      if (re.test(tok)) {
        codeIdx = i;
        code = tok;
        break;
      }
    }
    if (codeIdx !== -1) break;
  }

  // 4) Make: usually between unit and code, OR between qty and code,
  // OR sometimes before qty (rare).
  let make = "Unknown";
  if (codeIdx !== -1) {
    let makeStart =
      unitIdx !== -1
        ? unitIdx + 1
        : qtyIdx !== -1
        ? qtyIdx + 1
        : startIdx + 1;
    if (makeStart < codeIdx) {
      make = tokens.slice(makeStart, codeIdx).join(" ");
    } else if (qtyIdx > startIdx + 1) {
      // maybe: Paint GM/Chevy 0.5 Pint WA8624 White
      make = tokens.slice(startIdx + 1, qtyIdx).join(" ");
    }
  }

  // 5) Color: everything after code
  let color = "";
  if (codeIdx !== -1 && codeIdx < tokens.length - 1) {
    color = tokens.slice(codeIdx + 1).join(" ");
  }

  // Normalize unit
  const normalizedUnit = normalizeUnit(unit || "");

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
function extractLineItems(text) {
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
