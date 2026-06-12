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

    const pagWidth = 100;
    const pagHeight = 100;

    const prompt = `Analyze this page image of a form (Page ${pageNum || 1}) and detect all fillable fields (blanks, dotted lines, underline input zones, checkboxes, signature areas, or date/dropdown boxes).
We will use normalized PERCENTAGE coordinates from 0.0 to 100.0 relative to the image boundaries, where (0,0) is the absolute top-left corner of the page and (100,100) is the absolute bottom-right corner of the page.

For each detected field, provide:
1. "name": A unique, camelCase suggested field name prefixed with 'txt' for text (e.g., txtFullName), 'chk' for checkboxes (e.g., chkAgreed), 'img' for signature fields (e.g., imgSignature), or 'dt' for dates (e.g., dtBirth).
2. "type": One of: 'text', 'checkbox', 'signature', 'date', 'image', or 'dropdown'. Choose the best fitting classification.
3. "page": The page number, which is ${pageNum || 1}.
4. "x": Horizontal offset of the left edge of the input area as a percentage of the page width (0.0 to 100.0).
5. "y": Vertical offset of the top edge of the input area as a percentage of the page height (0.0 to 100.0).
6. "width": Width of the input area as a percentage of the page width (0.5 to 100.0).
7. "height": Height of the input area as a percentage of the page height (0.5 to 100.0).
8. "label": The literal printed/scanned text label detected nearby or associated with the field (e.g., "Full Name:", "Email Address:", "Date:").
9. "confidence": A decimal confidence score between 0.0 and 1.0.
10. "reasoning": A brief explanation of why this bounding area was located.

CRITICAL POSITIONING AND ALIGNMENT RULES FOR HIGH PRECISION:
- DO NOT COVER OR OVERLAP THE PRINTED TEXT LABELS (such as "שם המשקיע:", "על-ידי:", "תפקיד:", "תאריך:", or the checkbox/label characters) with the input bounding boxes! The input fields must be placed completely clear of any printed background characters. They should reside entirely on the blank space, underline, or empty spaces meant for fillable input.
- For Right-to-Left (RTL / Hebrew) forms, the printed label text (e.g., "שם המשקיע:") is on the RIGHT, and the blank space or underline is situated to the LEFT of that label characters. The bounding box ('x', 'y', 'width', 'height') must be positioned ON the underline to the LEFT of the label text, leaving a comfortable gap so that the label text is fully uncovered and visible.
- For Left-to-Right (LTR) forms, the text label is on the LEFT, and the blank underline is to the RIGHT. Place the field box strictly on the blank line to the right of the text label.
- Text and date fields MUST be placed EXACTLY on top of the horizontal underlines/guidelines where a human would write. Align the bottom edge of the field perfectly with the line so text typed in the field doesn't overlap or hang above/below the line.
- Do not make the input areas too tall. The height of a normal text input line should be about 1.5% to 2.5% of the page height. No thick overlapping blocks.
- Checkboxes should align horizontally in line with their associated text, should be square in shape (usually 1.5% to 2.2% wide and high), and should sit exactly on top of the printed checkbox outline, or right next to the corresponding checklist label text without overlapping it.
- Ensure fields do not collide, overlap, or obscure each other or any other printed instructions. Only cover active blank lines or whitespace inputs.

Return the structure matching the provided JSON schema. Ensure fields are properly separated and don't collide.`;

    const systemInstruction = `You are an incredibly precise layout OCR and design intelligence agent. Your task is to detect blank PDF form fields on page images and output their precise coordinates as normalized percentages (0.0 to 100.0) of the page width and height.
Top-left corner is (0,0), and bottom-right corner is (100,100).
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
                  description: "A list of identified blank fields on the form page with percentage coordinates relative to the page boundaries (0.0 to 100.0).",
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
                        description: `Horizontal offset of the left edge as a percentage of the page width (0.0 to 100.0)`,
                      },
                      y: {
                        type: Type.NUMBER,
                        description: `Vertical offset of the top edge as a percentage of the page height (0.0 to 100.0)`,
                      },
                      width: {
                        type: Type.NUMBER,
                        description: "Width as a percentage of the page width (0.5 to 100.0)",
                      },
                      height: {
                        type: Type.NUMBER,
                        description: "Height as a percentage of the page height (0.5 to 100.0)",
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
                  description: "The percentage dimensions of the form page (always 100 x 100)",
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
    if (!result.page_dimensions) {
      result.page_dimensions = { width: 100, height: 100 };
    } else {
      result.page_dimensions.width = 100;
      result.page_dimensions.height = 100;
    }
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
          const { width, height } = pdfPage.getSize();

          // Standardize incoming dimensions whether they are percentage or points
          const fWidthPercentage = f.w !== undefined ? f.w : (f.width !== undefined ? (f.width / width) * 100 : 20);
          const fHeightPercentage = f.h !== undefined ? f.h : (f.height !== undefined ? (f.height / height) * 100 : 5);

          const xPos = (f.x / 100) * width;
          // top-left to bottom-left relative mapping
          const yPos = height - ((f.y + fHeightPercentage) / 100) * height;
          const wBounds = (fWidthPercentage / 100) * width;
          const hBounds = (fHeightPercentage / 100) * height;

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
              x: xPos,
              y: yPos,
              width: wBounds,
              height: hBounds,
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
            if (isImageOrSigType) {
              labelText = "Signature";
            }

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

            // Set interactive button on top of page
            buttonField.addToPage(labelText, pdfPage, {
              x: xPos,
              y: yPos,
              width: wBounds,
              height: hBounds,
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

            try {
              buttonField.updateAppearances();
            } catch (appErr) {
              console.warn(`Could not update button appearances for ${uniqueName}:`, appErr);
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
              x: xPos,
              y: yPos,
              width: wBounds,
              height: hBounds,
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

    // Set header reporting any failures to the UI
    res.setHeader("X-Failed-Fields", JSON.stringify(failedFieldsReport));
    
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
