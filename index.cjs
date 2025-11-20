/**
 * WhatsApp Webhook – Cleaned, Sanitized, Media-Safe Version
 * Supports: text, image, video, audio, document, sticker, contacts, location
 */

const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, GRAPH_API_TOKEN, PORT } = process.env;

///////////////////////////////////////////////////////////////////////////
// 1. API WRAPPER
///////////////////////////////////////////////////////////////////////////
const wapi = (phoneId, data) =>
  axios({
    method: "POST",
    url: `https://graph.facebook.com/v18.0/${phoneId}/messages`,
    headers: { Authorization: `Bearer ${GRAPH_API_TOKEN}` },
    data,
  });

///////////////////////////////////////////////////////////////////////////
// 2. SANITIZATION HELPERS
///////////////////////////////////////////////////////////////////////////
function sanitizeWhatsAppParam(text = "") {
  return (text || "")
    .toString()
    .replace(/\t/g, " ")
    .replace(/\n/g, " ")
    .replace(/ {5,}/g, "    ")
    .replace(/[\u200B-\u200D\uFEFF]/g, ""); // zero-width chars
}

function sanitizeComponents(components = []) {
  return components.map((comp) => {
    if (!comp.parameters) return comp;

    return {
      ...comp,
      parameters: comp.parameters.map((p) => {
        if (p.type === "text" && p.text) {
          return { ...p, text: sanitizeWhatsAppParam(p.text) };
        }
        return p;
      }),
    };
  });
}

///////////////////////////////////////////////////////////////////////////
// 3. MEDIA DOWNLOAD + REUPLOAD (MIME-SAFE)
///////////////////////////////////////////////////////////////////////////
async function reuploadMedia(mediaId, phoneId) {
  // metadata
  const info = await axios({
    url: `https://graph.facebook.com/v18.0/${mediaId}`,
    method: "GET",
    headers: { Authorization: `Bearer ${GRAPH_API_TOKEN}` },
  });

  const mediaUrl = info.data.url;
  const mimeType = info.data.mime_type;
  const fileExt = mimeType?.split("/")[1] || "bin";

  // download
  const file = await axios({
    url: mediaUrl,
    method: "GET",
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${GRAPH_API_TOKEN}` },
  });

  // upload with correct MIME type
  const form = new FormData();
  form.append("file", Buffer.from(file.data), {
    filename: `file.${fileExt}`,
    contentType: mimeType,
  });
  form.append("messaging_product", "whatsapp");

  const upload = await axios({
    url: `https://graph.facebook.com/v18.0/${phoneId}/media`,
    method: "POST",
    data: form,
    headers: {
      Authorization: `Bearer ${GRAPH_API_TOKEN}`,
      ...form.getHeaders(),
    },
  });

  return upload.data.id;
}

///////////////////////////////////////////////////////////////////////////
// 4. FORWARD TO ADMIN (TEMPLATE-BASED)
///////////////////////////////////////////////////////////////////////////
async function forwardToAdmin(phoneId, templateName, components = []) {
  return wapi(phoneId, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "265888699977", // admin number
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" },
      components: sanitizeComponents(components),
    },
  });
}

///////////////////////////////////////////////////////////////////////////
// 5. AUTO REPLY
///////////////////////////////////////////////////////////////////////////
async function autoReply(phoneId, message) {
  return wapi(phoneId, {
    messaging_product: "whatsapp",
    to: message.from,
    type: "template",
    template: {
      name: "auto_response",
      language: { code: "en" },
    },
    context: { message_id: message.id },
  });
}

///////////////////////////////////////////////////////////////////////////
// 6. MARK MESSAGE AS READ
///////////////////////////////////////////////////////////////////////////
async function markRead(phoneId, messageId) {
  return wapi(phoneId, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  });
}

///////////////////////////////////////////////////////////////////////////
// 7. MARK MESSAGE AS READ
///////////////////////////////////////////////////////////////////////////
async function sendToServer(value) {
  const webUrl = "https://sis.seposale.com/api/1.0.0/whatsapp/callback";

  return axios.post(webUrl, { value });
}


///////////////////////////////////////////////////////////////////////////
// 8. MAIN WEBHOOK HANDLER
///////////////////////////////////////////////////////////////////////////
app.post("/webhook", async (req, res) => {
  console.log("Incoming:", JSON.stringify(req.body, null, 2));




  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    await sendToServer(change.value).then((res)=> { 
      console.log("API Response : " + res.status)
      console.log(res.data)
    })

    if (!message) return res.sendStatus(200);

    const phoneId = change.value.metadata.phone_number_id;

    ///////////////////////////////////////////////////////////////////////
    // TEXT
    ///////////////////////////////////////////////////////////////////////
    if (message.type === "text") {
      await forwardToAdmin(phoneId, "forwarded_response", [
        {
          type: "body",
          parameters: [
            { type: "text", text: message.from },
            { type: "text", text: message.text.body },
          ],
        },
      ]);
    }

    ///////////////////////////////////////////////////////////////////////
    // IMAGE
    ///////////////////////////////////////////////////////////////////////
    if (message.type === "image") {
      const newId = await reuploadMedia(message.image.id, phoneId);

      await forwardToAdmin(phoneId, "forwarded_image", [
        {
          type: "header",
          parameters: [{ type: "image", image: { id: newId } }],
        },
        {
          type: "body",
          parameters: [
            { type: "text", text: message.from },
            { type: "text", text: message.image.caption || "" },
          ],
        },
      ]);
    }

    ///////////////////////////////////////////////////////////////////////
    // VIDEO
    ///////////////////////////////////////////////////////////////////////
    if (message.type === "video") {
      const newId = await reuploadMedia(message.video.id, phoneId);

      await forwardToAdmin(phoneId, "forwarded_video", [
        {
          type: "header",
          parameters: [{ type: "video", video: { id: newId } }],
        },
        {
          type: "body",
          parameters: [
            { type: "text", text: message.from },
            { type: "text", text: message.video.caption || "" },
          ],
        },
      ]);
    }

    ///////////////////////////////////////////////////////////////////////
    // AUDIO
    ///////////////////////////////////////////////////////////////////////
    if (message.type === "audio") {
      const newId = await reuploadMedia(message.audio.id, phoneId);

      await forwardToAdmin(phoneId, "forwarded_document", [
        {
          type: "header",
          parameters: [ { type: "document", document: { id: newId, filename: newId } },],
        },
        {
          type: "body",
          parameters: [{ type: "text", text: message.from },
            { type: "text", text: "Uploaded Audio File:" + newId },

          ],
        },
      ]);
    }

    ///////////////////////////////////////////////////////////////////////
    // DOCUMENT
    ///////////////////////////////////////////////////////////////////////
    if (message.type === "document") {
      const newId = await reuploadMedia(message.document.id, phoneId);

      await forwardToAdmin(phoneId, "forwarded_document", [
        {
          type: "header",
          parameters: [
            // { type: "document", document: { id: newId, filename: message.document.filename } },
            { type: "document", document: { id: newId, filename: newId } },
          ],
        },
        {
          type: "body",
          parameters: [
            { type: "text", text: message.from },
            { type: "text", text: "Uploaded File:" + message.document.filename },
          ],
        },
      ]);
    }

    ///////////////////////////////////////////////////////////////////////
    // STICKER
    ///////////////////////////////////////////////////////////////////////
    if (message.type === "sticker") {
      const newId = await reuploadMedia(message.sticker.id, phoneId);

      await forwardToAdmin(phoneId, "forwarded_sticker", [
        {
          type: "header",
          parameters: [{ type: "image", image: { id: newId } }],
        },
        {
          type: "body",
          parameters: [{ type: "text", text: message.from }],
        },
      ]);
    }

    ///////////////////////////////////////////////////////////////////////
    // CONTACTS
    ///////////////////////////////////////////////////////////////////////
    if (message.type === "contacts") {
      await forwardToAdmin(phoneId, "forwarded_contacts", [
        {
          type: "body",
          parameters: [
            { type: "text", text: message.from },
            {
              type: "text",
              text: JSON.stringify(message.contacts),
            },
          ],
        },
      ]);
    }

    ///////////////////////////////////////////////////////////////////////
    // LOCATION
    ///////////////////////////////////////////////////////////////////////
    if (message.type === "location") {
      await forwardToAdmin(phoneId, "forwarded_location", [
        {
          type: "body",
          parameters: [
            { type: "text", text: message.from },
            {
              type: "text",
              text: `${message.location.latitude}, ${message.location.longitude}`,
            },
          ],
        },
      ]);
    }

    ///////////////////////////////////////////////////////////////////////
    // AUTO REPLY + MARK READ
    ///////////////////////////////////////////////////////////////////////
    await autoReply(phoneId, message);
    await markRead(phoneId, message.id);

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err);
    res.sendStatus(500);
  }
});

///////////////////////////////////////////////////////////////////////////
// 8. WEBHOOK VERIFICATION
///////////////////////////////////////////////////////////////////////////
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

///////////////////////////////////////////////////////////////////////////
// 9. TEST ENDPOINT
///////////////////////////////////////////////////////////////////////////
app.get("/", (req, res) => {
  res.send("WhatsApp Webhook Running");
});

///////////////////////////////////////////////////////////////////////////
// 10. START SERVER
///////////////////////////////////////////////////////////////////////////
app.listen(PORT || 3001, () => {
  console.log(`Webhook running on port ${PORT || 3001}`);
});
