import { PDFDocument, StandardFonts, TextAlignment, PDFName } from "pdf-lib";

function intersects(b1: { x: number; y: number; w: number; h: number }, b2: { x: number; y: number; w: number; h: number }): boolean {
  return !(
    b1.x + b1.w <= b2.x ||
    b2.x + b2.w <= b1.x ||
    b1.y + b1.h <= b2.y ||
    b2.y + b2.h <= b1.y
  );
}

function convertCoordinates(f: any, pageWidth: number, pageHeight: number) {
  const x = f.x !== undefined ? f.x : 0;
  const y = f.y !== undefined ? f.y : 0;
  const w = f.w !== undefined ? f.w : (f.width !== undefined ? f.width : 20);
  const h = f.h !== undefined ? f.h : (f.height !== undefined ? f.height : 5);

  let pdfX = 0, pdfY = 0, pdfWidth = 0, pdfHeight = 0, systemUsed = "pdf-points";

  if (x <= 100 && y <= 100 && w <= 100 && h <= 100) {
    systemUsed = "normalized (0-100)";
    pdfX = (x / 100) * pageWidth;
    pdfY = pageHeight - (((y + h) / 100) * pageHeight);
    pdfWidth = (w / 100) * pageWidth;
    pdfHeight = (h / 100) * pageHeight;
  } else if (x > pageWidth * 1.5 || y > pageHeight * 1.5) {
    systemUsed = "pixels (requires scaling from image space)";
    const scaleFactor = pageWidth / 1200;
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

  if (pdfWidth <= 0) pdfWidth = 40;
  if (pdfHeight <= 0) pdfHeight = 12;
  if (pdfX < 0) pdfX = 0;
  if (pdfY < 0) pdfY = 0;
  if (pdfX + pdfWidth > pageWidth) pdfWidth = pageWidth - pdfX;
  if (pdfY + pdfHeight > pageHeight) pdfHeight = pageHeight - pdfY;

  return { pdfX, pdfY, pdfWidth, pdfHeight };
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

  if (pdfX < 0 || pdfY < 0 || pdfX + pdfWidth > pageWidth || pdfY + pdfHeight > pageHeight) {
    return { score: 0.0, reason: "Field exceeds page bounds." };
  }

  if (pdfWidth < 5 || pdfHeight < 3) {
    score -= 0.2;
    reason = "Field is too small.";
  }
  if (pdfWidth > pageWidth * 0.95 || pdfHeight > pageHeight * 0.5) {
    score -= 0.3;
    reason = "Field is abnormally large.";
  }

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
          totalDeductions += 0.6;
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

async function runRegressionTest() {
  console.log("=== STARTING MATHEMATICAL & VISUAL PLACEMENT REGRESSION TEST SUITE ===");
  let passed = true;

  try {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 800]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const form = pdfDoc.getForm();

    // TEST 1: Coordinate translation and scale
    console.log("-> TEST 1: Verifying coordinate transformation logic");
    const testF = { name: "txtSignerName", x: 10, y: 15, w: 20, h: 5 };
    const { pdfX, pdfY, pdfWidth, pdfHeight } = convertCoordinates(testF, 600, 800);
    
    // Converted expectations:
    // pdfX: (10 / 100) * 600 = 60
    // pdfY: 800 - (((15 + 5)/100)*800) = 800 - 160 = 640
    // pdfWidth: (20 / 100) * 600 = 120
    // pdfHeight: (5 / 100) * 800 = 40
    if (pdfX !== 60 || pdfY !== 640 || pdfWidth !== 120 || pdfHeight !== 40) {
      console.error(`[FAIL] Expected [60,640,120,40], got [${pdfX}, ${pdfY}, ${pdfWidth}, ${pdfHeight}]`);
      passed = false;
    } else {
      console.log(`[PASS] Coordinate conversion mapped precisely to: [X:${pdfX}, Y:${pdfY}, W:${pdfWidth}, H:${pdfHeight}]`);
    }

    // TEST 2: Label Collision Overlap Detection
    console.log("-> TEST 2: Verifying collision scoring with overlaps");
    const collisionBoxes = [
      { name: "First Name printed text", x: 50, y: 630, w: 110, h: 30 }
    ];

    // Field overlapping direct printed label text should score low (<0.75)
    // Field coords: left=60, bot=640, w=120, h=40 -> right=180, top=680
    // Label coords: left=50, bot=630, w=110, h=30 -> right=160, top=660
    // Intersects at (60, 640) with dimensions (100, 20) -> area 2000. Field area is 4800. Ratio = 41.6%
    const { score: collisionScore, reason: scoreReason } = calculateSafePlacementScore(
      testF, pdfX, pdfY, pdfWidth, pdfHeight, pdfX, pdfY, pdfWidth, pdfHeight, collisionBoxes, 600, 800
    );

    if (collisionScore >= 0.75) {
      console.error(`[FAIL] Overlapping printed text should be rejected, but got score: ${collisionScore}`);
      passed = false;
    } else {
      console.log(`[PASS] Correctly detected collision overlap! Score reduced to: ${collisionScore.toFixed(3)}. Reason: ${scoreReason}`);
    }

    // TEST 3: Anchor-based Spacing Shifting (Collision Avoidance)
    console.log("-> TEST 3: Verifying label-splitting anchor shift");
    let testX = pdfX;
    let testY = pdfY;
    let testW = pdfWidth;
    let testH = pdfHeight;

    // Shift to the right of the colliding label: label.x + label.w + 10 = 50 + 110 + 10 = 170
    const colBox = collisionBoxes[0];
    const shiftedXRight = colBox.x + colBox.w + 10;
    
    // Validate shift does not overlap parent printed text label
    const shiftedOverlap = intersects(
      { x: shiftedXRight, y: testY, w: testW, h: testH },
      colBox
    );

    if (shiftedOverlap) {
      console.error("[FAIL] Shifted box still overlaps label text!");
      passed = false;
    } else {
      const { score: shiftScore } = calculateSafePlacementScore(
        testF, shiftedXRight, testY, testW, testH, pdfX, pdfY, pdfWidth, pdfHeight, collisionBoxes, 600, 800
      );
      if (shiftScore < 0.75) {
        console.error(`[FAIL] Shifted box should be accepted as safe, but got score: ${shiftScore}`);
        passed = false;
      } else {
        console.log(`[PASS] Shifted safely to X=${shiftedXRight}, score rose to ${shiftScore.toFixed(3)} (threshold approved!).`);
      }
    }

    // TEST 4: Signature / Image Placeholders Aesthetics Transparency
    console.log("-> TEST 4: Verifying signature and image visual placeholders");
    const sigName = "btnSignature";
    const sigField = form.createButton(sigName);
    sigField.addToPage("", page, { x: 50, y: 100, width: 100, height: 35 });

    // Validate setting transparentcharacteristics BG and BC safely
    const widgets = sigField.acroField.getWidgets();
    if (widgets.length === 0) {
      console.error("[FAIL] Button field widget assembly missing.");
      passed = false;
    } else {
      for (const widget of widgets) {
        const ac = widget.getOrCreateAppearanceCharacteristics();
        ac.dict.set(PDFName.of('BG'), ac.dict.context.obj([]));
        ac.dict.set(PDFName.of('BC'), ac.dict.context.obj([]));
      }
      console.log("[PASS] Successfully set transparent empty array values [] on characteristics.");
    }

    // TEST 5: Verify button appearance update is resilient to missing fonts
    console.log("-> TEST 5: Resilient button appearance with font updates");
    try {
      sigField.updateAppearances(font);
      console.log("[PASS] Safely calling updateAppearances on transparent button placeholders with valid font.");
    } catch (btnErr: any) {
      console.error("[FAIL] Transparency appearance update crashed:", btnErr);
      passed = false;
    }

    await pdfDoc.save();
  } catch (err: any) {
    console.error("Global regression run issue:", err);
    passed = false;
  }

  if (passed) {
    console.log("=== REGRESSION TEST PASSED SUCCESSFULLY ===");
  } else {
    console.error("=== REGRESSION TEST FAILED ===");
    process.exit(1);
  }
}

runRegressionTest();
