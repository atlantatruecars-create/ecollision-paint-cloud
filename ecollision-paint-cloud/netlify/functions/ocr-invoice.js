exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { imageBase64, imageUrl } = body;

    if (!imageBase64 && !imageUrl) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "imageBase64 or imageUrl is required" }),
      };
    }

    // PLACEHOLDER OCR RESPONSE
    // A developer will replace this with real OCR later
    const parsed = {
      supplier: "Sample Supplier",
      invoice_number: "INV-12345",
      cost: 250.0,
      notes: "OCR placeholder – replace with real OCR",
    };

    return {
      statusCode: 200,
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error", details: String(err) }),
    };
  }
};
