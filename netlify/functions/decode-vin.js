// netlify/functions/decode-vin.js

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const vin = (body.vin || "").trim().toUpperCase();

    if (!vin || vin.length < 11) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid VIN" }),
      };
    }

    // Free NHTSA VIN decode API (no key needed)
    const apiUrl = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(
      vin
    )}?format=json`;

    const res = await fetch(apiUrl);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error("VIN API error " + res.status + ": " + txt);
    }

    const data = await res.json();
    const result = data.Results && data.Results[0] ? data.Results[0] : {};

    const year = result.ModelYear || "";
    const make = result.Make || "";
    const model = result.Model || "";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vin,
        year,
        make,
        model,
        raw: result, // extra info if you ever need it
      }),
    };
  } catch (err) {
    console.error("decode-vin error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Server error", details: String(err) }),
    };
  }
};
