const { handleChat, sendJson } = require("../lib/handlers");

module.exports = (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  return handleChat(req, res);
};
