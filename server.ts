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

    const pagWidth = pageDimensions?.width || 595;
    const pagHeight = pageDimensions?.height || 842;

    const prompt = `Analyze this page image of a form (Page ${pageNum || 1}) and detect all input areas, blanks, boxes, checkboxes, or signature fields.
The target page dimensions are exactly ${pagWidth} wide x ${pagHeight} high points.
For each detected field, provide:
1. "name": A unique, camelCase suggested field name prefixed with 'txt' for text (e.g., txtFullName), 'chk' for checkboxes (e.g., chkAgreed), 'img' for signature fields (e.g., imgSignature), or 'dt' for dates (e.g., dtBirth).
2. "type": One of: 'text', 'checkbox', 'signature', 'date', 'image', or 'dropdown'. Choose the best fitting classification.
3. "page": The page number, which is ${pageNum || 1}.
4. "x": Absolute horizontal offset in PDF points from the left-most corner (0 to ${pagWidth}).
5. "y": Absolute vertical offset in PDF points from the top-most edge (0 to ${pagHeight}).
6. "width": Absolute width of the field in PDF points (1 to ${pagWidth}).
7. "height": Absolute height of the field in PDF points (1 to ${pagHeight}).
8. "label": The literal printed/scanned text label detected nearby or associated with the field (e.g., "Full Name:", "Email Address:", "I agree bounds", "Date:").
9. "confidence": A decimal confidence score between 0.0 and 1.0.
10. "reasoning": A brief explanation of why this bounding area was located (e.g., "Found labeled box next to 'Full Name' of size 140x20").

Return the structure matching the provided JSON schema. Ensure fields are properly separated and don't collide.`;

    const systemInstruction = `You are an incredibly precise layout OCR and design intelligence agent. Your task is to detect blank PDF form fields on page images and output their precise coordinates in PDF points.
The current page dimensions are ${pagWidth} x ${pagHeight} points.
Classify field types strictly into: 'text', 'checkbox', 'signature', 'date', 'image', or 'dropdown'.`;

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
                  description: "A list of identified blank fields on the form page with absolute point coordinates.",
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: {
                        type: Type.STRING,
                        description: "CamelCase field name (e.g. txtInvestorName, chkQualify, imgSignature)",
                      },
                      type: {
                        type: Type.STRING,
                        description: "Form element type: text, checkbox, signature, date, image, dropdown",
                      },
                      page: {
                        type: Type.INTEGER,
                        description: "Page number on which this field lies",
                      },
                      x: {
                        type: Type.NUMBER,
                        description: `Absolute X coordinate top-left corner in PDF points (0 to ${pagWidth})`,
                      },
                      y: {
                        type: Type.NUMBER,
                        description: `Absolute Y coordinate top-left corner in PDF points (0 to ${pagHeight})`,
                      },
                      width: {
                        type: Type.NUMBER,
                        description: "Width of field in PDF points",
                      },
                      height: {
                        type: Type.NUMBER,
                        description: "Height of field in PDF points",
                      },
                      label: {
                        type: Type.STRING,
                        description: "Label text detected nearby (e.g. 'Full Name', 'Phone number')",
                      },
                      confidence: {
                        type: Type.NUMBER,
                        description: "Normalized placement confidence (0.0 to 1.0)",
                      },
                      reasoning: {
                        type: Type.STRING,
                        description: "Reasoning and visual cue description",
                      }
                    },
                    required: ["name", "type", "page", "x", "y", "width", "height"],
                  },
                },
                page_dimensions: {
                  type: Type.OBJECT,
                  description: "The point dimensions of the form page",
                  properties: {
                    width: { type: Type.NUMBER },
                    height: { type: Type.NUMBER }
                  },
                  required: ["width", "height"]
                },
                detection_method: {
                  type: Type.STRING,
                  description: "Method of detection used"
                }
              },
              required: ["fields", "page_dimensions"],
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

// TEMPLATE_COLLISION_BOXES keeps printed labels coordinates in normalized percentage space
const TEMPLATE_COLLISION_BOXES: Record<string, { name: string; x: number; y: number; w: number; h: number }[]> = {
  w9: [
    { name: "Form W-9 Header Area", x: 3, y: 3, w: 94, h: 6 },
    { name: "1. Name Label", x: 5, y: 11, w: 30, h: 3 },
    { name: "2. Business Name Label", x: 5, y: 16, w: 30, h: 3 },
    { name: "3. Classification Instructions Area", x: 5, y: 21, w: 90, h: 3 },
    { name: "Individual/Sole checkbox label text", x: 12, y: 24.5, w: 10, h: 2 },
    { name: "C Corp checkbox label text", x: 25, y: 24.5, w: 5, h: 2 },
    { name: "S Corp checkbox label text", x: 35, y: 24.5, w: 5, h: 2 },
    { name: "5. Address Line Label", x: 5, y: 32, w: 30, h: 3 },
    { name: "6. City State Zip Label", x: 5, y: 38, w: 30, h: 3 },
    { name: "Part I Header Block", x: 4, y: 46, w: 92, h: 4 },
    { name: "Part I Guidance text", x: 5, y: 51, w: 90, h: 2.5 },
    { name: "Social Security Number title", x: 57, y: 54, w: 20, h: 2.5 },
    { name: "Part II Header Block", x: 4, y: 63, w: 92, h: 4 },
    { name: "Part II Certification Rules details", x: 5, y: 67, w: 90, h: 3 },
    { name: "Sign Here branding box", x: 4, y: 70, w: 15, h: 5 },
    { name: "Signature of U.S. Person label", x: 11, y: 75.5, w: 30, h: 2 },
  ],
  sub: [
    { name: "Confidential Memorandum Header area", x: 4, y: 4, w: 92, h: 5 },
    { name: "Slate Co-Investment Label text", x: 4, y: 9, w: 92, h: 3 },
    { name: "I. Investor Info Header", x: 4, y: 14, w: 92, h: 3 },
    { name: "Investor Full Name Label text", x: 6, y: 17, w: 20, h: 2 },
    { name: "E-mail Label text", x: 6, y: 24, w: 22, h: 2 },
    { name: "II. Qualified Status Header banner", x: 4, y: 30, w: 92, h: 3 },
    { name: "Accredited Investor checkbox text", x: 9, y: 32, w: 85, h: 4 },
    { name: "Commitment Amount Label text", x: 6, y: 38, w: 25, h: 2 },
    { name: "III. Execution Info Label text", x: 4, y: 45, w: 92, h: 3 },
    { name: "Authorized Signatory Label text", x: 6, y: 51, w: 25, h: 2 },
    { name: "Signature Date Label text", x: 65, y: 51, w: 15, h: 2 },
  ],
  hebrewSchool: [
    { name: "טופס רישום כותרת ראשית", x: 25, y: 4, w: 50, h: 4 },
    { name: "משרד החינוך כותרת משנה", x: 35, y: 8, w: 30, h: 2.5 },
    { name: "תאריך עליון תוויות", x: 55, y: 48.5, w: 10, h: 2 },
    { name: "שם המצהיר תווית טקסט", x: 48, y: 54.3, w: 10, h: 2 },
    { name: "שם בית הספר תווית טקסט", x: 32, y: 56.5, w: 12, h: 2 },
    { name: "שם הילד תווית טקסט", x: 58, y: 58.8, w: 10, h: 2 },
    { name: "תעודת זהות תווית טקסט", x: 12, y: 58.8, w: 10, h: 2 },
    { name: "אישור מעקב תיבות טקסט תיאור", x: 70, y: 66, w: 10, h: 2 },
    { name: "לקות למידה תיבות טקסט תיאור", x: 70, y: 68, w: 10, h: 2 },
    { name: "בעיות התנהגות תיבות טקסט תיאור", x: 70, y: 69.5, w: 10, h: 2 },
    { name: "שם הורה 1 תווית טקסט", x: 44, y: 80, w: 10, h: 2 },
    { name: "כתובת הורה 1 תווית טקסט", x: 20, y: 80, w: 10, h: 2 },
    { name: "תאריך הורה 1 תווית טקסט", x: 44, y: 82.3, w: 10, h: 2 },
    { name: "לחצני חתימה הסבר טקסט", x: 30, y: 86.5, w: 50, h: 2 },
  ],
};

function intersects(b1: { x: number; y: number; w: number; h: number }, b2: { x: number; y: number; w: number; h: number }): boolean {
  return !(
    b1.x + b1.w <= b2.x ||
    b2.x + b2.w <= b1.x ||
    b1.y + b1.h <= b2.y ||
    b2.y + b2.h <= b1.y
  );
}

// Extracts printed vector text positions from a lazy-loaded pdf page node stream to handle upload PDFs
function extractPDFTextPoints(pdfPage: any, pdfDoc: any): Array<{ text: string; x: number; y: number; w: number; h: number }> {
  const result: Array<{ text: string; x: number; y: number; w: number; h: number }> = [];
  try {
    const contentsRef = pdfPage.node.Contents();
    if (!contentsRef) return result;

    const context = pdfDoc.context;
    let refs: any[] = [];
    if (contentsRef.array && typeof contentsRef.array === "function") {
      refs = contentsRef.array();
    } else if (Array.isArray(contentsRef)) {
      refs = contentsRef;
    } else if (contentsRef.asArray && typeof contentsRef.asArray === "function") {
      refs = contentsRef.asArray();
    } else {
      refs = [contentsRef];
    }

    for (const ref of refs) {
      if (!ref) continue;
      const stream = context.lookup(ref);
      if (!stream) continue;

      let bytes: Uint8Array | null = null;
      if (typeof stream.getUncompressedEncodedValues === "function") {
        bytes = stream.getUncompressedEncodedValues();
      } else if (typeof stream.decode === "function") {
        bytes = stream.decode();
      }

      if (!bytes) continue;
      const text = new TextDecoder("utf-8").decode(bytes);
      
      const btBlocks = text.match(/BT[\s\S]*?ET/g) || [];
      for (const block of btBlocks) {
        let currentX = 0;
        let currentY = 0;
        let lineX = 0;
        let lineY = 0;
        let fontSize = 10;

        const lines = block.split(/\r?\n/);
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length === 0) continue;

          const op = parts[parts.length - 1];
          if (op === "Tm") {
            const e = parseFloat(parts[parts.length - 3]);
            const f = parseFloat(parts[parts.length - 2]);
            if (!isNaN(e) && !isNaN(f)) {
              currentX = e;
              currentY = f;
              lineX = e;
              lineY = f;
            }
          } else if (op === "Td" || op === "TD") {
            const tx = parseFloat(parts[parts.length - 3]);
            const ty = parseFloat(parts[parts.length - 2]);
            if (!isNaN(tx) && !isNaN(ty)) {
              currentX = lineX + tx;
              currentY = lineY + ty;
              lineX = currentX;
              lineY = currentY;
            }
          } else if (op === "T*") {
            currentX = lineX;
            currentY = lineY - fontSize;
            lineY = currentY;
            lineX = currentX;
          } else if (op === "Tf") {
            const size = parseFloat(parts[parts.length - 2]);
            if (!isNaN(size)) fontSize = size;
          } else if (op === "Tj") {
            const match = line.match(/\((.*?)\)\s*Tj/);
            if (match) {
              const textVal = match[1];
              if (textVal.trim()) {
                result.push({
                  text: textVal,
                  x: currentX,
                  y: currentY,
                  w: textVal.length * fontSize * 0.6,
                  h: fontSize
                });
              }
            }
          } else if (op === "TJ") {
            const matchStr = line.match(/\[([\s\S]*?)\]\s*TJ/);
            if (matchStr) {
              const content = matchStr[1];
              const strings = (content.match(/\((.*?)\)/g) || []).map(s => s.slice(1, -1)).join(" ");
              if (strings.trim()) {
                result.push({
                  text: strings,
                  x: currentX,
                  y: currentY,
                  w: strings.length * fontSize * 0.6,
                  h: fontSize
                });
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("Failed scanning PDF page text stream:", err);
  }
  return result;
}

function getCollisionBoxes(templateId: string, pdfPage: any, pdfDoc: any): Array<{ name: string; x: number; y: number; w: number; h: number }> {
  const { width, height } = pdfPage.getSize();
  const boxes: Array<{ name: string; x: number; y: number; w: number; h: number }> = [];

  // Add static pre-defined template areas
  const staticConfig = TEMPLATE_COLLISION_BOXES[templateId];
  if (staticConfig) {
    for (const b of staticConfig) {
      const boxX = (b.x / 100) * width;
      const boxY = height - (((b.y + b.h) / 100) * height);
      const boxW = (b.w / 100) * width;
      const boxH = (b.h / 100) * height;
      boxes.push({
        name: b.name,
        x: boxX,
        y: boxY,
        w: boxW,
        h: boxH
      });
    }
  }

  // Add dynamically extracted text strings
  const extracted = extractPDFTextPoints(pdfPage, pdfDoc);
  for (const item of extracted) {
    boxes.push({
      name: item.text,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h
    });
  }

  return boxes;
}

function convertCoordinates(f: any, pageWidth: number, pageHeight: number) {
  const x = f.x !== undefined ? f.x : 0;
  const y = f.y !== undefined ? f.y : 0;
  const w = f.w !== undefined ? f.w : (f.width !== undefined ? f.width : 20);
  const h = f.h !== undefined ? f.h : (f.height !== undefined ? f.height : 5);

  let pdfX = 0;
  let pdfY = 0;
  let pdfWidth = 0;
  let pdfHeight = 0;
  let systemUsed = "pdf-points";

  // Check if coordinates look normalized (0-100) vs point space
  if (x <= 100 && y <= 100 && w <= 100 && h <= 100) {
    systemUsed = "normalized (0-100)";
    pdfX = (x / 100) * pageWidth;
    pdfY = pageHeight - (((y + h) / 100) * pageHeight);
    pdfWidth = (w / 100) * pageWidth;
    pdfHeight = (h / 100) * pageHeight;
  } else if (x > pageWidth * 1.5 || y > pageHeight * 1.5) {
    systemUsed = "pixels (requires scaling from image space)";
    const scaleFactor = pageWidth / 1200; // assume 1200 max page size base
    pdfX = x * scaleFactor;
    pdfWidth = w * scaleFactor;
    pdfHeight = h * scaleFactor;
    pdfY = pageHeight - ((y * scaleFactor) + pdfHeight);
  } else {
    systemUsed = "pdf-points (top-left)";
    pdfX = x;
    pdfWidth = w;
    pdfHeight = h;
    pdfY = pageHeight - (y + h);
  }

  // Boundaries safeguard clamp
  if (pdfWidth <= 0) pdfWidth = 40;
  if (pdfHeight <= 0) pdfHeight = 12;
  if (pdfX < 0) pdfX = 0;
  if (pdfY < 0) pdfY = 0;
  if (pdfX + pdfWidth > pageWidth) pdfWidth = pageWidth - pdfX;
  if (pdfY + pdfHeight > pageHeight) pdfHeight = pageHeight - pdfY;

  console.log(`[COORD CONVERT] field='${f.name}' y-offset | original=[x:${x}, y:${y}, w:${w}, h:${h}] -> systemUsed='${systemUsed}' -> pdfX=${pdfX.toFixed(2)}, pdfY=${pdfY.toFixed(2)}, width=${pdfWidth.toFixed(2)}, height=${pdfHeight.toFixed(2)}, page=[${pageWidth}x${pageHeight}]`);

  return { pdfX, pdfY, pdfWidth, pdfHeight, systemUsed };
}

function calculateSafePlacementScore(
  f: any,
  pdfX: number,
  pdfY: number,
  pdfWidth: number,
  pdfHeight: number,
  origX: number,
  origY: number,
  origW: number,
  origH: number,
  collisionBoxes: any[],
  pageWidth: number,
  pageHeight: number
) {
  let score = 1.0;
  let reason = "Safe field placement verified successfully.";

  // Out of bounds check
  if (pdfX < 0 || pdfY < 0 || pdfX + pdfWidth > pageWidth || pdfY + pdfHeight > pageHeight) {
    return { score: 0.0, reason: "Field exceeds page bounds." };
  }

  // Excess size check
  if (pdfWidth < 5 || pdfHeight < 3) {
    score -= 0.2;
    reason = "Field is too small.";
  }
  if (pdfWidth > pageWidth * 0.95 || pdfHeight > pageHeight * 0.5) {
    score -= 0.3;
    reason = "Field is abnormally large.";
  }

  // Deep collision scan
  let totalDeductions = 0;
  for (const b of collisionBoxes) {
    const interX = Math.max(pdfX, b.x);
    const interY = Math.max(pdfY, b.y);
    const interW = Math.min(pdfX + pdfWidth, b.x + b.w) - interX;
    const interH = Math.min(pdfY + pdfHeight, b.y + b.h) - interY;

    if (interW > 0 && interH > 0) {
      const interArea = interW * interH;
      const fieldArea = pdfWidth * pdfHeight;
      const overlapRatio = interArea / fieldArea;

      if (overlapRatio > 0.05) {
        const isHeader = b.name.toLowerCase().includes("header") || 
                         b.name.toLowerCase().includes("block") || 
                         b.name.toLowerCase().includes("כותרת") ||
                         b.w > pageWidth * 0.8;

        if (isHeader) {
          totalDeductions += 0.8;
        } else if (overlapRatio > 0.8) {
          totalDeductions += 0.6; // heavy overlap covering text
        } else {
          totalDeductions += 0.35;
        }
      }
    }
  }

  if (totalDeductions > 0) {
    score -= totalDeductions;
    reason = `Collision with printed text/labels (reduced score by ${totalDeductions.toFixed(2)}).`;
  }

  // Give horizontal alignment proximity bonus
  let hasLabelBonus = false;
  for (const b of collisionBoxes) {
    const labelCenterY = b.y + b.h / 2;
    const fieldCenterY = pdfY + pdfHeight / 2;
    const verticalDiff = Math.abs(labelCenterY - fieldCenterY);
    
    const dist = Math.min(
      Math.abs(pdfX - (b.x + b.w)),
      Math.abs((pdfX + pdfWidth) - b.x)
    );

    if (verticalDiff < 15 && dist < 120) {
      hasLabelBonus = true;
    }
  }

  if (hasLabelBonus && score >= 0.7) {
    score += 0.15;
  }

  const finalScore = Math.max(0.0, Math.min(1.0, score));
  return { score: finalScore, reason: finalScore >= 0.75 ? "Safe placement verified successfully." : reason };
}

// Endpoint to inject interactive fields into a PDF document
app.post("/api/bake-pdf", async (req, res) => {
  try {
    const { pdfBase64, imgBase64, fields, language, templateId } = req.body;
    const { PDFDocument, TextAlignment, rgb, StandardFonts, PDFName } = await import("pdf-lib");
    
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
      const isA4 = templateId === "hebrewSchool";
      const pw = isA4 ? 595 : 612;
      const ph = isA4 ? 842 : 792;
      const page = pdfDoc.addPage([pw, ph]);
      
      // Draw background styling depending on the template selected
      page.drawRectangle({
        x: 0,
        y: 0,
        width: pw,
        height: ph,
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
      } else if (templateId === "sub") {
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
      } else {
        // hebrewSchool registration form page visual layouts
        page.drawText("Registration Form and Parental Declaration", { x: 40, y: 800, size: 14 });
        page.drawText("טופס רישום והצהרת הורים לבית הספר", { x: 40, y: 780, size: 14 });
        page.drawLine({ start: { x: 35, y: 760 }, end: { x: 560, y: 760 }, thickness: 2, color: rgb(0, 0, 0) });
        
        page.drawText("Declaration Details & Dates / פרטי הצהרה ותאריכים", { x: 35, y: 730, size: 10 });
        page.drawText("Top Date / תאריך עשייה במערכת:", { x: 35, y: 700, size: 9 });
        page.drawLine({ start: { x: 200, y: 700 }, end: { x: 300, y: 700 }, thickness: 1, color: rgb(0.5, 0.5, 0.5) });

        page.drawText("Student & Signee Info / פרטי המוסד והמצהיר", { x: 35, y: 640, size: 10 });
        page.drawText("Signee Name:", { x: 35, y: 610, size: 9 });
        page.drawText("School / Institution Name:", { x: 35, y: 580, size: 9 });
        page.drawText("Child Name / ID Number:", { x: 35, y: 550, size: 9 });

        page.drawText("Criteria Checklist / מעקב והצהרות בריאותיות ולימודיות", { x: 35, y: 460, size: 10 });
        page.drawText("[ ] Approved Grades Tracker / אישור ציונים", { x: 40, y: 430, size: 9 });
        page.drawText("[ ] Learning Disabilities Declaration / הצהרת לקות", { x: 40, y: 410, size: 9 });
        page.drawText("[ ] Behavioral or Discipline Status", { x: 40, y: 390, size: 9 });

        page.drawText("Parents Details & Guardian Status / פרטי הורים והצהרה", { x: 35, y: 310, size: 10 });
        page.drawText("Parent 1 Name / Parent 1 Address:", { x: 35, y: 280, size: 9 });
        page.drawText("Parent 1 Date:", { x: 35, y: 250, size: 9 });

        page.drawText("Digital Active Buttons / לחצני חתימה ואישור מסמכים דיגיטליים:", { x: 35, y: 150, size: 10 });
        page.drawText("Interactive buttons programmed strictly to Adobe specifications.", { x: 35, y: 130, size: 8 });
      }
    }
    
    const form = pdfDoc.getForm();
    const isRtl = language === "rtl";
    const failedFieldsReport: Array<{ name: string; type: string; page: number; error: string }> = [];
    const debugReport: any[] = [];
    const isDebugMode = req.body.debug === true || req.query.debug === "true";

    // 2. Embed a standard font once per PDF
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    if (fields && Array.isArray(fields)) {
      for (const f of fields) {
        // Safe logging of field details
        console.log(`Baking PDF Field: name=${f.name}, type=${f.type}, page=${f.page}, x=${f.x}, y=${f.y}, w=${f.w || f.width}, h=${f.h || f.height}`);

        try {
          // Handle pages bounds and coordinate calculation safely
          const pageIndex = Math.max(0, Math.min(pdfDoc.getPageCount() - 1, (f.page || 1) - 1));
          const pdfPage = pdfDoc.getPage(pageIndex);
          const { width: pageWidth, height: pageHeight } = pdfPage.getSize();

          // 1. Convert coordinates with full logging and validation
          const { pdfX: initX, pdfY: initY, pdfWidth: initW, pdfHeight: initH, systemUsed } = convertCoordinates(f, pageWidth, pageHeight);

          let finalX = initX;
          let finalY = initY;
          let finalW = initW;
          let finalH = initH;
          let placementStatus = "safe";

          // Get all collision printed labels/texts on this page
          const collisionBoxes = getCollisionBoxes(templateId, pdfPage, pdfDoc);

          // 2. Add printed-text collision detection & avoidance
          let collides = false;
          let collidingBox: any = null;
          for (const box of collisionBoxes) {
            if (intersects({ x: finalX, y: finalY, w: finalW, h: finalH }, box)) {
              collides = true;
              collidingBox = box;
              break;
            }
          }

          if (collides && collidingBox) {
            console.log(`[COLLISION DETECTED] field='${f.name}' interacts with printed label/text='${collidingBox.name}' [x:${collidingBox.x.toFixed(1)}, y:${collidingBox.y.toFixed(1)}, w:${collidingBox.w.toFixed(1)}, h:${collidingBox.h.toFixed(1)}]`);
            
            // Separate label location from input location (treating the collidee as an anchor and shifting to blank area)
            // LTR preferred direction: Right
            // RTL preferred direction: Left
            let shiftedSafe = false;
            if (isRtl) {
              const shiftedXLeft = collidingBox.x - finalW - 10;
              if (shiftedXLeft >= 10) {
                let secondCollision = false;
                for (const b of collisionBoxes) {
                  if (intersects({ x: shiftedXLeft, y: finalY, w: finalW, h: finalH }, b)) {
                    secondCollision = true;
                    break;
                  }
                }
                if (!secondCollision) {
                  finalX = shiftedXLeft;
                  placementStatus = "adjusted";
                  shiftedSafe = true;
                  console.log(`[COLLISION SHIFT RTL] Shifted field='${f.name}' left of anchor label. New X=${finalX.toFixed(2)}`);
                }
              }
            } else {
              const shiftedXRight = collidingBox.x + collidingBox.w + 10;
              if (shiftedXRight + finalW <= pageWidth - 10) {
                let secondCollision = false;
                for (const b of collisionBoxes) {
                  if (intersects({ x: shiftedXRight, y: finalY, w: finalW, h: finalH }, b)) {
                    secondCollision = true;
                    break;
                  }
                }
                if (!secondCollision) {
                  finalX = shiftedXRight;
                  placementStatus = "adjusted";
                  shiftedSafe = true;
                  console.log(`[COLLISION SHIFT LTR] Shifted field='${f.name}' right of anchor label. New X=${finalX.toFixed(2)}`);
                }
              }
            }

            if (!shiftedSafe) {
              console.log(`[COLLISION] Could not find any safe adjustment for field='${f.name}'. Placement remains at original coordinate, will be scored.`);
            }
          }

          // 3. Compute the safe placement score
          const { score: safeScore, reason: scoreReason } = calculateSafePlacementScore(
            f, finalX, finalY, finalW, finalH, initX, initY, initW, initH, collisionBoxes, pageWidth, pageHeight
          );

          console.log(`[SCORE] field='${f.name}' -> Score=${safeScore.toFixed(2)}, Status=${placementStatus}, Reason='${scoreReason}'`);

          debugReport.push({
            name: f.name,
            type: f.type,
            page: f.page || 1,
            originalCoordinates: { x: initX, y: initY, w: initW, h: initH },
            finalCoordinates: { x: finalX, y: finalY, w: finalW, h: finalH },
            placementStatus: safeScore >= 0.75 ? placementStatus : "rejected",
            score: safeScore,
            reason: scoreReason
          });

          // 4. Create visual debug/preview overlays on the canvas ONLY if isDebugMode is active
          if (isDebugMode) {
            let overlayColor = rgb(0, 0.8, 0); // Green
            let labelPrefix = "[SAFE]";
            if (safeScore < 0.75) {
              overlayColor = rgb(0.9, 0, 0); // Red (rejected / low score)
              labelPrefix = "[REJECTED]";
            } else if (placementStatus === "adjusted") {
              overlayColor = rgb(0.8, 0.7, 0); // Yellow (shifted / adjusted due to anchor label overlap)
              labelPrefix = "[ADJUSTED]";
            }

            // Draw rectangle border
            pdfPage.drawRectangle({
              x: finalX,
              y: finalY,
              width: finalW,
              height: finalH,
              borderColor: overlayColor,
              borderWidth: 1.5,
              color: overlayColor,
              opacity: 0.12,
            });

            // Draw thin cross lines for rejected fields
            if (safeScore < 0.75) {
              pdfPage.drawLine({
                start: { x: finalX, y: finalY },
                end: { x: finalX + finalW, y: finalY + finalH },
                color: overlayColor,
                thickness: 1,
              });
              pdfPage.drawLine({
                start: { x: finalX, y: finalY + finalH },
                end: { x: finalX + finalW, y: finalY },
                color: overlayColor,
                thickness: 1,
              });
            }

            // Draw text tag near the box
            try {
              const debugFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
              pdfPage.drawText(`${labelPrefix} ${f.name} (Ch:${safeScore.toFixed(2)})`, {
                x: finalX,
                y: Math.max(5, finalY - 7),
                size: 6,
                font: debugFont,
                color: overlayColor,
              });
            } catch (err) {
              console.warn("Could not draw visual overlay text label:", err);
            }
          }

          // 5. Enforce score threshold
          if (safeScore < 0.75) {
            console.log(`[REJECTED] Bypassed creating physical field for '${f.name}' because placement score ${safeScore.toFixed(2)} is below 0.75 threshold.`);
            failedFieldsReport.push({
              name: f.name || "unnamed",
              type: f.type || "unknown",
              page: f.page || 1,
              error: `Warning: Field '${f.name}' was rejected (needs manual review). Score: ${safeScore.toFixed(2)}. Reason: ${scoreReason}`
            });
            continue; // Skip adding active widget
          }

          // Ensure name contains no spaces and is completely unique
          let cleanName = (f.name || "field").replace(/\s+/g, "");
          let uniqueName = cleanName;
          let count = 1;
          while (form.getFields().some((existing: any) => existing.getName() === uniqueName)) {
            uniqueName = `${cleanName}_${count++}`;
          }

          // Enforce strict field grouping requirements
          const isCheckbox = f.type === "checkbox";
          const isButtonOrImageOrSignature = f.type === "button" || f.type === "image" || f.type === "signature" || uniqueName.startsWith("imgSignature") || uniqueName.startsWith("signature");

          if (isCheckbox) {
            const checkBox = form.createCheckBox(uniqueName);
            checkBox.addToPage(pdfPage, {
              x: finalX,
              y: finalY,
              width: finalW,
              height: finalH,
              borderWidth: 0,
            });

            // Set explicit transparent background & border [] to satisfy all PDF renders safely
            try {
              const widgets = checkBox.acroField.getWidgets();
              for (const widget of widgets) {
                const ac = widget.getOrCreateAppearanceCharacteristics();
                ac.dict.set(PDFName.of('BG'), ac.dict.context.obj([]));
                ac.dict.set(PDFName.of('BC'), ac.dict.context.obj([]));
              }
            } catch (acErr) {
              console.warn(`Failed to set transparent characteristics for checkbox ${uniqueName}:`, acErr);
            }

            try {
              checkBox.updateAppearances();
            } catch (appErr) {
              console.warn(`Failed to update checkbox appearance for ${uniqueName}:`, appErr);
            }
          } else if (isButtonOrImageOrSignature) {
            // Ensure button, image, and signature tags are created as interactive button/placeholder widgets
            const buttonField = form.createButton(uniqueName);

            let labelText = f.value || f.name;
            const isImageOrSigType = f.type === "image" || f.type === "signature" || uniqueName.startsWith("imgSignature") || uniqueName.startsWith("signature");
            
            // Signature / Image gets completely transparent look with no caption
            if (isImageOrSigType) {
              labelText = "";
            } else {
              // Map common Hebrew labels or symbols safely to avoid embed/font crashes
              const hasNonAscii = /[^\x00-\x7F]/.test(labelText);
              if (hasNonAscii) {
                const lowerCheck = labelText.toLowerCase();
                if (lowerCheck.includes("sign") || lowerCheck.includes("signature") || lowerCheck.includes("חתימה") || lowerCheck.includes("חתום")) {
                  labelText = "Signature";
                } else if (lowerCheck.includes("date") || lowerCheck.includes("תאריך") || lowerCheck.includes("יום")) {
                  labelText = "Date / Stamp";
                } else if (lowerCheck.includes("approve") || lowerCheck.includes("אישור") || lowerCheck.includes("כן")) {
                  labelText = "Approve";
                } else {
                  labelText = "Click to Sign";
                }
              }
            }

            // Set interactive button on top of page
            buttonField.addToPage(labelText, pdfPage, {
              x: finalX,
              y: finalY,
              width: finalW,
              height: finalH,
              borderWidth: 0,
            });

            // Set transparent appearance characteristics to avoid covering existing text
            try {
              const widgets = buttonField.acroField.getWidgets();
              for (const widget of widgets) {
                const ac = widget.getOrCreateAppearanceCharacteristics();
                ac.dict.set(PDFName.of('BG'), ac.dict.context.obj([]));
                ac.dict.set(PDFName.of('BC'), ac.dict.context.obj([]));
              }
            } catch (acErr) {
              console.warn(`Failed to set transparent characteristics for button ${uniqueName}:`, acErr);
            }

            // Only update button appearances with embedded font if not transparent signature
            if (!isImageOrSigType) {
              try {
                const appearanceFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
                buttonField.updateAppearances(appearanceFont);
              } catch (appErr) {
                console.warn(`Could not update button appearances for ${uniqueName}:`, appErr);
              }
            }
          } else {
            // Text-like fields, which strictly comprise text, textarea, or date
            const textField = form.createTextField(uniqueName);
            if (f.type === "textarea") {
              textField.enableMultiline();
            }

            const fieldAlign = f.align || "center";
            if (fieldAlign === "right") {
              textField.setAlignment(TextAlignment.Right);
            } else if (fieldAlign === "center") {
              textField.setAlignment(TextAlignment.Center);
            } else {
              textField.setAlignment(TextAlignment.Left);
            }

            if (f.value !== undefined && f.value !== "") {
              textField.setText(f.value);
            }

            // 1. Do not call setFontSize() directly on newly created fields unless they have DA
            let hasDA = false;
            try {
              const acroField = (textField as any).acroField;
              if (acroField && typeof acroField.getDA === "function") {
                hasDA = !!acroField.getDA();
              }
            } catch (daError) {
              hasDA = false;
            }

            if (hasDA) {
              try {
                textField.setFontSize(f.fontSize || 12);
              } catch (fsErr) {
                console.warn(`Could not set font size immediately for ${uniqueName}:`, fsErr);
              }
            }

            textField.addToPage(pdfPage, {
              x: finalX,
              y: finalY,
              width: finalW,
              height: finalH,
              borderWidth: 0,
            });

            // Make textfield perfectly transparent without Safari opaque white/black fallback box
            try {
              const widgets = textField.acroField.getWidgets();
              for (const widget of widgets) {
                const ac = widget.getOrCreateAppearanceCharacteristics();
                ac.dict.set(PDFName.of('BG'), ac.dict.context.obj([]));
                ac.dict.set(PDFName.of('BC'), ac.dict.context.obj([]));
              }
            } catch (acErr) {
              console.warn(`Failed to set transparent characteristics for textfield ${uniqueName}:`, acErr);
            }
          }
        } catch (fieldErr: any) {
          // Robust error catching and logs
          console.error(`Error adding field ${f.name} (type: ${f.type}, page: ${f.page}):`, fieldErr);
          failedFieldsReport.push({
            name: f.name || "unnamed",
            type: f.type || "unknown",
            page: f.page || 1,
            error: fieldErr.message || String(fieldErr)
          });
        }
      }
    }

    // 3. After all fields are created and added, update appearances with the embedded font
    try {
      form.updateFieldAppearances(font);
    } catch (uErr) {
      console.warn("Global field appearances update completed with non-fatal issues:", uErr);
    }

    // Set header reporting any failures & debugging reports to the UI
    res.setHeader("X-Failed-Fields", JSON.stringify(failedFieldsReport));
    res.setHeader("X-Debug-Report", JSON.stringify(debugReport));
    
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
