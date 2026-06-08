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

// Endpoint to inject interactive fields into a PDF document
app.post("/api/bake-pdf", async (req, res) => {
  try {
    const { pdfBase64, imgBase64, fields, language, templateId } = req.body;
    const { PDFDocument, TextAlignment, rgb } = await import("pdf-lib");
    
    let pdfDoc: any;
    
    if (pdfBase64) {
      // Decode user-supplied PDF file
      const pdfBytes = Buffer.from(pdfBase64.replace(/^data:application\/pdf;base64,/, ""), "base64");
      pdfDoc = await PDFDocument.load(pdfBytes);
    } else if (imgBase64) {
      // User supplied a scanned document image (PNG or JPG). Embed it as the background of a fresh PDF.
      pdfDoc = await PDFDocument.create();
      const cleanImgBase64 = imgBase64.replace(/^data:image\/\w+;base64,/, "");
      const imgBuffer = Buffer.from(cleanImgBase64, "base64");
      
      let embeddedImage: any;
      if (imgBase64.includes("image/png")) {
        embeddedImage = await pdfDoc.embedPng(imgBuffer);
      } else {
        embeddedImage = await pdfDoc.embedJpg(imgBuffer);
      }
      
      const { width, height } = embeddedImage.scale(1.0);
      const page = pdfDoc.addPage([width, height]);
      
      page.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width,
        height,
      });
    } else {
      // If user is bake-downloading a built-in template, construct a high-fidelity vector PDF page
      pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]);
      
      // Draw background styling depending on the template selected
      page.drawRectangle({
        x: 0,
        y: 0,
        width: 612,
        height: 792,
        color: rgb(0.98, 0.98, 0.96), // pristine warm paper off-white
      });
      
      if (templateId === "w9") {
        page.drawText("Form W-9 (Interactive Baked Fillable PDF)", { x: 30, y: 740, size: 14 });
        page.drawText("Department of the Treasury - Internal Revenue Service", { x: 30, y: 720, size: 8 });
        page.drawLine({
          start: { x: 30, y: 700 },
          end: { x: 582, y: 700 },
          thickness: 2,
          color: rgb(0, 0, 0),
        });
        page.drawText("1. Taxpayer Name (as shown on your income tax return)", { x: 35, y: 670, size: 9 });
        page.drawLine({ start: { x: 35, y: 645 }, end: { x: 320, y: 645 }, thickness: 1, color: rgb(0.5, 0.5, 0.5) });
        
        page.drawText("2. Business classification checkboxes (Individual / Sole / S-Corp)", { x: 35, y: 600, size: 9 });
        page.drawText("Part I: Taxpayer Identification Number (TIN)", { x: 35, y: 500, size: 10 });
        page.drawRectangle({ x: 35, y: 470, width: 542, height: 20, color: rgb(0.95, 0.95, 0.95) });
        page.drawText("Part II: Signatures & Certification", { x: 35, y: 380, size: 10 });
        page.drawText("Signature of U.S. Person:", { x: 35, y: 340, size: 9 });
      } else {
        page.drawText("REAL ESTATE INVESTMENTS SUBSCRIPTION AGREEMENT", { x: 40, y: 740, size: 14 });
        page.drawText("SLATE CO-INVESTMENT FUND L.P. - CONFIDENTIAL MEMORANDUM", { x: 40, y: 722, size: 8 });
        page.drawLine({
          start: { x: 40, y: 710 },
          end: { x: 572, y: 710 },
          thickness: 1,
          color: rgb(0.7, 0.7, 0.7),
        });
        page.drawText("I. INVESTOR INFORMATION", { x: 40, y: 680, size: 10 });
        page.drawText("Investor Full Legal Entity / Name:", { x: 45, y: 650, size: 9 });
        page.drawText("Contact E-mail Address:", { x: 45, y: 610, size: 9 });
        page.drawText("II. QUALIFIED INVESTOR STATUS & CERTIFICATION", { x: 40, y: 550, size: 10 });
        page.drawText("Commitment Amount (USD):", { x: 45, y: 510, size: 9 });
        page.drawText("III. EXECUTION & AUTHORIZED SIGNATURE", { x: 40, y: 420, size: 10 });
      }
    }
    
    const form = pdfDoc.getForm();
    const isRtl = language === "rtl";
    
    if (fields && Array.isArray(fields)) {
      for (const f of fields) {
        // Handle pages bounds and coordinate calculation
        const pageIndex = Math.max(0, Math.min(pdfDoc.getPageCount() - 1, (f.page || 1) - 1));
        const pdfPage = pdfDoc.getPage(pageIndex);
        const { width, height } = pdfPage.getSize();
        
        const xPos = (f.x / 100) * width;
        // top-left to bottom-left relative mapping
        const yPos = height - ((f.y + f.h) / 100) * height;
        const wBounds = (f.w / 100) * width;
        const hBounds = (f.h / 100) * height;
        
        // Ensure name contains no spaces and is completely unique
        let cleanName = (f.name || "field").replace(/\s+/g, "");
        let uniqueName = cleanName;
        let count = 1;
        while (form.getFields().some((existing: any) => existing.getName() === uniqueName)) {
          uniqueName = `${cleanName}_${count++}`;
        }
        
        try {
          if (f.type === "checkbox") {
            const checkBox = form.createCheckBox(uniqueName);
            checkBox.addToPage(pdfPage, {
              x: xPos,
              y: yPos,
              width: wBounds,
              height: hBounds,
            });
          } else {
            // text, textarea, or image signature placeholders
            const textField = form.createTextField(uniqueName);
            if (f.type === "textarea") {
              textField.enableMultiline();
            }
            
            // Text alignment support based on field property, with overall language/RTL fallback
            const fieldAlign = f.align || (isRtl ? "right" : "left");
            if (fieldAlign === "right") {
              textField.setAlignment(TextAlignment.Right);
            } else if (fieldAlign === "center") {
              textField.setAlignment(TextAlignment.Center);
            } else {
              textField.setAlignment(TextAlignment.Left);
            }
            
            textField.addToPage(pdfPage, {
              x: xPos,
              y: yPos,
              width: wBounds,
              height: hBounds,
            });
          }
        } catch (fieldErr) {
          console.error(`Error adding field ${f.name}:`, fieldErr);
        }
      }
    }
    
    // Save as Buffer and transfer
    const bakedPdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=fillable_form.pdf");
    res.send(Buffer.from(bakedPdfBytes));
  } catch (error: any) {
    console.error("Error baking PDF with fields:", error);
    res.status(500).json({ error: error.message || "Failed to package fillable PDF on the server." });
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
