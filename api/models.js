const { handleModels, sendJson } = require("../lib/handlers");
const { isApiRequest, listModels } = require("../lib/apikeys");

module.exports = (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }); return res.end(); }
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  // /v1/models (an API key) is rewritten here too, see vercel.json
  if (isApiRequest(req)) return listModels(req, res);
  return handleModels(req, res);
};
