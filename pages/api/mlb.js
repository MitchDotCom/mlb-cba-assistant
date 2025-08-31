// pages/api/mlb.js
export default async function handler(req, res) {
  return res.status(410).json({ result: "Deprecated. Use /api/chat." });
}
