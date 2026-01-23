// netlify/functions/ocr-invoice.js

exports.handler = async (event) => {
  // Only allow POST
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
        body: JSON.stringify({ error: "Missing GCV_API_KEY env var in Netlify" }),
        headers: { "Content-Type": "application/json" },
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { imageBase64, imageUrl } = body;

    if (!imageBase64 && !imageUrl) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "imageBase64 or imageUrl is required" }),
        headers: { "Content-Type": "application/json" },
      };
    }

    // Prepare base64 content for Vision
    let contentBase64 = null;
    if (imageBase64) {
      // Strip "data:image/jpeg;base64,..." prefix if present
      const parts = imageBase64.split(",");
      contentBase64 = parts.length > 1 ? parts[1] : parts[0];
    }

    // Build Google Vision request payload
    const visionRequest = {
      requests: [
        {
          image: imageUrl
            ? { source: { imageUri: imageUrl } }
            : { content: contentBase64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        },
      ],
    };

    // Call Google Vision API
    const visionUrl = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;

    const visionRes = await fetch(visionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(visionRequest),
    });

    if (!visionRes.ok) {
      const errText = await visionRes.text();
      throw new Error(`Vision API error ${visionRes.status}: ${errText}`);
    }

    const visionData = await visionRes.json();
    const resp = (visionData.responses && visionData.responses[0]) || {};

    const fullText =
      (resp.fullTextAnnotation && resp.fullTextAnnotation.text) || "";

    if (!fullText) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          supplier: "",
          invoice_number: "",
          cost: null,
          notes: "OCR ran but no text detected.",
        }),
        headers: { "Content-Type": "application/json" },
      };
    }

    // ---- Simple parsing helpers ----
    const supplier = extractSupplier(fullText);
    const invoiceNumber = extractInvoiceNumber(fullText);
    const cost = extractTotalAmount(fullText);

    // Truncate notes a bit so it's not crazy long
    const notesSnippet = fullText.length > 800 ? fullText.slice(0, 800) + "..." : fullText;

    const parsed = {
      supplier,
      invoice_number: invoiceNumber,
      cost,
      notes: notesSnippet,
    };

    return {
      statusCode: 200,
      body: JSON.stringify(parsed),
      headers: { "Content-Type": "application/json" },
    };
  } catch (err) {
    console.error("OCR function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error", details: String(err) }),
      headers: { "Content-Type": "application/json" },
    };
  }
};

// ----- Parsing helpers -----

function extractSupplier(text) {
  // Take the first non-empty line that doesn't look like "Invoice", "Total", etc.
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return "";

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (
      lower.includes("invoice") ||
      lower.includes("bill to") ||
      lower.includes("ship to") ||
      lower.includes("total")
    ) {
      continue;
    }
    // avoid lines that are mostly numbers
    const digitCount = (line.match(/\d/g) || []).length;
    if (digitCount > line.length * 0.5) continue;
    return line;
  }

  // fallback: first line
  return lines[0];
}

function extractInvoiceNumber(text) {
  // Try patterns like INV-12345, Invoice # 12345, etc.
  const invRegexes = [
    /invoice\s*#\s*([A-Za-z0-9\-]+)/i,
    /invoice\s*no\.?\s*([A-Za-z0-9\-]+)/i,
    /inv[\s\-:]*([A-Za-z0-9\-]+)/i,
  ];

  for (const re of invRegexes) {
    const m = text.match(re);
    if (m && m[1]) return m[1];
  }

  // Fallback: find a line containing "invoice"
  const line = text
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().includes("invoice"));
  return line || "";
}

function extractTotalAmount(text) {
  // Try to find "Total" or "Amount Due" lines with amounts
  const totalRegexes = [
    /(total|amount due|balance due)[^\d]*([\$]?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
    /([\$]\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*(total)/i,
  ];

  for (const re of totalRegexes) {
    const m = text.match(re);
    if (m && m[2]) {
      const amtStr = m[2].replace(/[^0-9.,]/g, "").replace(/,/g, "");
      const num = parseFloat(amtStr);
      if (!isNaN(num)) return num;
    } else if (m && m[1]) {
      const amtStr = m[1].replace(/[^0-9.,]/g, "").replace(/,/g, "");
      const num = parseFloat(amtStr);
      if (!isNaN(num)) return num;
    }
  }

  // Fallback: biggest money-like number in the whole text
  const moneyMatches = text.match(/[\$]?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g) || [];
  let best = null;
  for (const m of moneyMatches) {
    const amtStr = m.replace(/[^0-9.,]/g, "").replace(/,/g, "");
    const num = parseFloat(amtStr);
    if (!isNaN(num)) {
      if (best === null || num > best) best = num;
    }
  }
  return best;
}
