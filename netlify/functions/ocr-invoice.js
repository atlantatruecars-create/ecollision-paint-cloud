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

    const visionUrl = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;

    // Call Google Vision API
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

    // ---- Extract key fields from text ----
    const supplier = extractSupplier(fullText);
    const invoiceNumber = extractInvoiceNumber(fullText);
    const cost = extractTotalAmount(fullText);
    const notesSnippet = extractLineItems(fullText) ||
      (fullText.length > 800 ? fullText.slice(0, 800) + "..." : fullText);

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

// =====================
// Parsing helpers tuned for invoices like "Paint My Ride"
// =====================

function extractSupplier(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return "";

  // Look at the top few lines (where PAINT MY RIDE lives)
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i];

    const lower = line.toLowerCase();
    if (
      lower.includes("invoice") ||
      lower.includes("bill to") ||
      lower.includes("ship to") ||
      lower.includes("amount due") ||
      lower.includes("total") ||
      lower.includes("page") ||
      lower.includes("date") ||
      lower.includes("tucker, ga") || // address line, skip
      lower.includes("www.") ||       // website, skip
      lower.includes(".com")
    ) {
      continue;
    }

    // Must have some letters
    const letters = (line.match(/[a-z]/gi) || []).length;
    if (letters < 4) continue;

    // Not mostly numbers
    const digits = (line.match(/\d/g) || []).length;
    if (digits > line.length * 0.5) continue;

    return line;
  }

  // fallback: first non-empty line
  return lines[0];
}

function extractInvoiceNumber(text) {
  // Specific style: "Invoice # 1807583"
  const m = text.match(/Invoice\s*#\s*([0-9]+)/i);
  if (m && m[1]) return m[1];

  // More generic fallbacks
  const patterns = [
    /invoice\s*no\.?\s*[:\-]?\s*([A-Za-z0-9\-]+)/i,
    /invoice\s*number\s*[:\-]?\s*([A-Za-z0-9\-]+)/i,
    /inv[\s\-:]*#?\s*([A-Za-z0-9\-]+)/i,
  ];

  for (const re of patterns) {
    const mm = text.match(re);
    if (mm && mm[1]) return mm[1];
  }

  // Fallback: return the line that contains the word "invoice"
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().includes("invoice"));

  return line || "";
}

function extractTotalAmount(text) {
  // Look specifically for "Total $202.00" or "Total 202.00"
  const m = text.match(/Total\s*\$?\s*([\d,]+\.\d{2})/i);
  if (m && m[1]) {
    return parseFloat(m[1].replace(/,/g, ""));
  }

  // Fallback: Amount Due / Balance Due
  const alt = text.match(
    /(amount due|balance due)\s*\$?\s*([\d,]+\.\d{2})/i
  );
  if (alt && alt[2]) {
    return parseFloat(alt[2].replace(/,/g, ""));
  }

  return null;
}

// Pull out paint line items into notes
function extractLineItems(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const items = [];

  for (const line of lines) {
    // Capture lines like: "Paint 2 Quarts k3g 122.00 122.00"
    if (/paint/i.test(line) && /\d+\.\d{2}/.test(line)) {
      items.push(line);
    }
  }

  return items.join("\n");
}
