import express from "express";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

// Load environment variables
dotenv.config();

// Ensure GEMINI_API_KEY is available
const apiKey = process.env.GEMINI_API_KEY;

// Initialize GoogleGenAI server-side with AI Studio User-Agent telemetry
let ai: GoogleGenAI | null = null;
if (apiKey) {
  ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

const app = express();
const PORT = 3000;

// Middleware for parsing large JSON payloads (scanned page images in base64 can be large)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    hasApiKey: !!apiKey,
  });
});

// Endpoint to detect fields in an image via Gemini
app.post("/api/detect-fields", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is not configured in environment variables.",
      });
    }

    const { image, pageNum, pageDimensions } = req.body;
    if (!image) {
      return res.status(400).json({ error: "No image provided." });
    }

    // Strip header if any (e.g. "data:image/png;base64,")
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");

    const prompt = `Analyze this page image of a form (Page ${pageNum || 1}) and detect all input areas, blanks, boxes, checkboxes, or signature fields.
For each detected field, provide:
1. A unique, camelCase name prefixed with 'txt' for text (e.g., txtFullName), 'chk' for checkboxes (e.g., chkAgreed), or 'img' for signature paths/images (e.g., imgSignature).
2. The field type: 'text', 'textarea', 'checkbox', or 'image'.
3. The bounding box as percentages of the total image size (0 to 100):
   - x: percentage from the left wall
   - y: percentage from the top ceiling
   - w: width as percentage of the page width
   - h: height as percentage of the page height

Be extremely precise. Locate line fields, underline blanks, boxed input grids, standard squares, and signature lines. Return the structure strictly matching the provided JSON schema. Ensure fields don't severely overlap.`;

    const systemInstruction = `You are a precise physical design assistant. Your job is to extract form-field bounding boxes from document images.
You must find all empty lines, text input boxes, checkboxes, or image-signature placeholders.
Specify coordinates (x, y, w, h) as percentage numbers from 0.0 to 100.0 related to the top-left origin.
Classify types into 'text' (single-line), 'textarea' (multiline), 'checkbox' (toggle box), or 'image' (signature/image placeholder).
Use clear prefix conventions: 'txt' (text, textarea), 'chk' (checkbox), 'img' (signature/image).`;

    const modelsToTry = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];
    let lastError: any = null;
    let response: any = null;

    for (const modelName of modelsToTry) {
      try {
        console.log(`Attempting field detection using model: ${modelName}...`);
        response = await ai.models.generateContent({
          model: modelName,
          contents: [
            {
              inlineData: {
                mimeType: "image/png",
                data: base64Data,
              },
            },
            { text: prompt },
          ],
          config: {
            systemInstruction: systemInstruction,
            temperature: 0.1, // low temperature for precise OCR & coordinate detection
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                fields: {
                  type: Type.ARRAY,
                  description: "A list of identified blank fields on the form page.",
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: {
                        type: Type.STRING,
                        description: "Unique descriptive field name (e.g., txtInvestorName, chkQualify, imgSignature)",
                      },
                      type: {
                        type: Type.STRING,
                        description: "Form element type: text, textarea, checkbox, image",
                      },
                      x: {
                        type: Type.NUMBER,
                        description: "X coordinate of top-left corner as percentage of width (0-100)",
                      },
                      y: {
                        type: Type.NUMBER,
                        description: "Y coordinate of top-left corner as percentage of height (0-100)",
                      },
                      w: {
                        type: Type.NUMBER,
                        description: "Width of field as percentage of total page width (0-100)",
                      },
                      h: {
                        type: Type.NUMBER,
                        description: "Height of field as percentage of total page height (0-100)",
                      },
                    },
                    required: ["name", "type", "x", "y", "w", "h"],
                  },
                },
              },
              required: ["fields"],
            },
          },
        });

        if (response && response.text) {
          console.log(`Success with model: ${modelName}`);
          break;
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`Model ${modelName} failed or unavailable:`, err?.message || err);
      }
    }

    if (!response || !response.text) {
      throw lastError || new Error("All fallback models timed out or failed to respond.");
    }

    const responseText = response.text;
    if (!responseText) {
      throw new Error("No output received from Gemini API");
    }

    const result = JSON.parse(responseText.trim());
    res.json(result);
  } catch (error: any) {
    console.error("Gemini detection error:", error);
    res.status(500).json({ error: error.message || "Failed to analyze page with Gemini." });
  }
});

// Setup Vite Dev middlewares or static file serving
async function initializeServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // For SPA Routing
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running at http://0.0.0.0:${PORT}`);
  });
}

initializeServer().catch((err) => {
  console.error("Failed to start server:", err);
});
