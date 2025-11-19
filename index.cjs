/**
 * WhatsApp Webhook – Template-based Admin Forwarding
 */

const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, GRAPH_API_TOKEN, PORT } = process.env;

///////////////////////////////////////////////////////////////////////////
// 1. FACEBOOK API WRAPPER
///////////////////////////////////////////////////////////////////////////
const wapi = (phoneId, data) =>
  axios({
    method: "POST",
    url: `https://graph.facebook.com/v18.0/${phoneId}/messages`,
    headers: { Authorization: `Bearer ${GRAPH_API_TOKEN}` },
    data,
  });

///////////////////////////////////////////////////////////////////////////
// 2. MEDIA DOWNLOAD + REUPLOAD
///////////////////////////////////////////////////////////////////////////
async function reuploadMedia(mediaId, phoneId) {
  const info = await axios({
    url: `https://graph.facebook.com/v18.0/${mediaId}`,
    method: "GET",
    headers: { Authorization: `Bearer ${GRAPH_API_TOKEN}` },
  });

  const mediaUrl = info.data.url;

  const file = await axios({
    url: mediaUrl,
    method: "GET",
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${GRAPH_API_TOKEN}` },
  });

  const form = new FormData();
  form.append("file", Buffer.from(file.data), { filename: "file" });
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
// 3. FORWARD TO ADMIN — TEMPLATE MESSAGE
///////////////////////////////////////////////////////////////////////////
async function forwardToAdmin(phoneId, templateName, params = []) {
  return wapi(phoneId, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "265888699977",
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" },
      components: params,
    },
  });
}

///////////////////////////////////////////////////////////////////////////
// 4. AUTO REPLY TO USER
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
// 5. MARK MESSAGE AS READ
///////////////////////////////////////////////////////////////////////////
async function markRead(phoneId, messageId) {
  return wapi(phoneId, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  });
}

///////////////////////////////////////////////////////////////////////////
// 6. MAIN WEBHOOK HANDLER
///////////////////////////////////////////////////////////////////////////
app.post("/webhook", async (req, res) => {
  console.log("Incoming:", JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const phoneId = change.value.metadata.phone_number_id;

    switch (message.type) {

      //////////////////////////////////////////////////////////////////////
      // TEXT MESSAGE
      //////////////////////////////////////////////////////////////////////
      case "text":
        await forwardToAdmin(phoneId, "forwarded_response", [
          {
            type: "body",
            parameters: [
              { type: "text", text: message.from },
              { type: "text", text: message.text.body },
            ],
          },
        ]);
        break;

      //////////////////////////////////////////////////////////////////////
      // IMAGE
      //////////////////////////////////////////////////////////////////////
      case "image": {
        const newId = await reuploadMedia(message.image.id, phoneId);
        await forwardToAdmin(phoneId, "forwarded_image", [
          {
            type: "header",
            parameters: [
              { type: "image", image: { id: newId } }
            ],
          },
          {
            type: "body",
            parameters: [
              { type: "text", text: message.from },
              { type: "text", text: message.image.caption || "" },
            ],
          },
        ]);
        break;
      }

      //////////////////////////////////////////////////////////////////////
      // VIDEO
      //////////////////////////////////////////////////////////////////////
      case "video": {
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
        break;
      }

      //////////////////////////////////////////////////////////////////////
      // AUDIO
      //////////////////////////////////////////////////////////////////////
      case "audio": {
        const newId = await reuploadMedia(message.audio.id, phoneId);
        await forwardToAdmin(phoneId, "forwarded_document", [
          {
            type: "header",
            parameters: [{ type: "audio", audio: { id: newId } }],
          },
          {
            type: "body",
            parameters: [{ type: "text", text: message.from }],
          },
        ]);
        break;
      }

      //////////////////////////////////////////////////////////////////////
      // DOCUMENT
      //////////////////////////////////////////////////////////////////////
      case "document": {
        const newId = await reuploadMedia(message.document.id, phoneId);
        await forwardToAdmin(phoneId, "forwarded_document", [
          {
            type: "header",
            parameters: [{ type: "document", document: { id: newId } }],
          },
          {
            type: "body",
            parameters: [
              { type: "text", text: message.from },
              { type: "text", text: message.document.filename },
            ],
          },
        ]);
        break;
      }

      //////////////////////////////////////////////////////////////////////
      // STICKER
      //////////////////////////////////////////////////////////////////////
      case "sticker": {
        const newId = await reuploadMedia(message.sticker.id, phoneId);
        await forwardToAdmin(phoneId, "forwarded_image", [
          {
            type: "header",
            parameters: [{ type: "image", image: { id: newId } }],
          },
          {
            type: "body",
            parameters: [
              { type: "text", text: message.from },
              { type: "text", text: "Sticker received" },
            ],
          },
        ]);
        break;
      }

      //////////////////////////////////////////////////////////////////////
      // CONTACTS
      //////////////////////////////////////////////////////////////////////
      case "contacts":
        await forwardToAdmin(phoneId, "forwarded_contacts", [
          {
            type: "body",
            parameters: [
              { type: "text", text: message.from },
              { type: "text", text: JSON.stringify(message.contacts, null, 2) },
            ],
          },
        ]);
        break;

      //////////////////////////////////////////////////////////////////////
      // LOCATION
      //////////////////////////////////////////////////////////////////////
      case "location":
        await forwardToAdmin(phoneId, "forwarded_location", [
          {
            type: "body",
            parameters: [
              { type: "text", text: message.from },
              { type: "text", text: `${message.location.latitude}` },
              { type: "text", text: `${message.location.longitude}` },
            ],
          },
        ]);
        break;

      default:
        console.log("Unhandled:", message.type);
    }

    await autoReply(phoneId, message);
    await markRead(phoneId, message.id);

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err);
    res.sendStatus(500);
  }
});

///////////////////////////////////////////////////////////////////////////
// 7. VERIFY WEBHOOK
///////////////////////////////////////////////////////////////////////////
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

///////////////////////////////////////////////////////////////////////////
// 8. TEST ROUTE
///////////////////////////////////////////////////////////////////////////
app.get("/", (req, res) => {
  res.send("WhatsApp Webhook Running");
});

///////////////////////////////////////////////////////////////////////////
// 9. START SERVER
///////////////////////////////////////////////////////////////////////////
app.listen(PORT || 3001, () => {
  console.log(`Server running on ${PORT || 3001}`);
});
