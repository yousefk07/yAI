// Which cloud media features are set up. Each one is a RunPod serverless ComfyUI endpoint plus a
// workflow in workflows/ (ComfyUI "Export (API)" format, with "$prompt" and "$image" placeholders).
//
//   image  text → image          Qwen-Image 2.1                 RUNPOD_IMAGE_ENDPOINT_ID  workflows/t2i.json
//   edit   image → image         Qwen-Image 2.1 Edit            RUNPOD_EDIT_ENDPOINT_ID   workflows/edit.json
//   video  text/image → video    MiniMax H3 (first frame opt.)  RUNPOD_VIDEO_ENDPOINT_ID  workflows/video.json

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || "";

// Static requires so Vercel bundles the files; a missing workflow just turns that feature off.
const tryRequire = (fn) => { try { return fn(); } catch { return null; } };
const WORKFLOWS = {
  image: tryRequire(() => require("../workflows/t2i.json")),
  edit: tryRequire(() => require("../workflows/edit.json")),
  video: tryRequire(() => require("../workflows/video.json")),
};

const ENDPOINTS = {
  image: process.env.RUNPOD_IMAGE_ENDPOINT_ID || "",
  edit: process.env.RUNPOD_EDIT_ENDPOINT_ID || "",
  video: process.env.RUNPOD_VIDEO_ENDPOINT_ID || "",
};

const enabled = (kind) => !!(RUNPOD_API_KEY && ENDPOINTS[kind] && WORKFLOWS[kind]);
const features = () => ({ imageGen: enabled("image"), imageEdit: enabled("edit"), videoGen: enabled("video") });

module.exports = { RUNPOD_API_KEY, WORKFLOWS, ENDPOINTS, enabled, features };
