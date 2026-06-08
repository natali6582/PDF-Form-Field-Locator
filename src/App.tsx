import React, { useState, useEffect, useRef } from "react";
import { 
  FileText, Upload, RefreshCw, ChevronLeft, ChevronRight, 
  Trash2, Plus, Download, Copy, Check, Info, ZoomIn, ZoomOut, AlertCircle, Sparkles, FileSpreadsheet, Layers, Crop
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// Load PDF.js dynamically from CDN to prevent Vite bundle/worker compilation issues
const loadPdfJs = (): Promise<any> => {
  return new Promise((resolve, reject) => {
    if ((window as any).pdfjsLib) {
      resolve((window as any).pdfjsLib);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      const pdfjsLib = (window as any).pdfjsLib;
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve(pdfjsLib);
    };
    script.onerror = () => reject(new Error("Failed to load PDF.js from CDN."));
    document.head.appendChild(script);
  });
};

interface FormField {
  id: string;
  name: string;
  type: "text" | "textarea" | "checkbox" | "image";
  x: number; // percentage from left (0 - 100)
  y: number; // percentage from top (0 - 100)
  w: number; // percentage of width (0 - 100)
  h: number; // percentage of height (0 - 100)
  page: number;
}

export default function App() {
  // Application Modes
  const [docSource, setDocSource] = useState<"template" | "pdf" | "image">("template");
  const [templateId, setTemplateId] = useState<"w9" | "sub">("w9");
  
  // PDF state
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfPagesCount, setPdfPagesCount] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pdfPoints, setPdfPoints] = useState<{ width: number; height: number }>({ width: 612, height: 792 }); // default Letter Size points
  const [canvasDimensions, setCanvasDimensions] = useState<{ width: number; height: number }>({ width: 612, height: 792 });

  // Uploaded Image State
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);

  // Crop / Selection Area State
  const [cropModeActive, setCropModeActive] = useState<boolean>(false);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Interaction State
  const [fields, setFields] = useState<FormField[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [zoomScale, setZoomScale] = useState<number>(1.0);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverConnected, setServerConnected] = useState<boolean>(true);

  // Dragging / Resizing states
  const [dragState, setDragState] = useState<{
    id: string;
    action: "drag" | "resize" | "draw";
    startX: number;
    startY: number;
    originalX: number;
    originalY: number;
    originalW: number;
    originalH: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Check backend server connection and API Key status
  useEffect(() => {
    const checkServer = async () => {
      try {
        const res = await fetch("/api/health");
        const data = await res.json();
        setServerConnected(true);
        if (!data.hasApiKey) {
          setErrorMessage("GEMINI_API_KEY environment variable is not configured on the server. Please set it in the Secrets panel.");
        }
      } catch (err) {
        setServerConnected(false);
        setErrorMessage("Could not connect to the backend server. Make sure the development server is running.");
      }
    };
    checkServer();
  }, []);

  // Set initial mock schema fields for templates
  useEffect(() => {
    if (docSource === "template") {
      setPdfPoints({ width: 612, height: 792 });
      if (templateId === "w9") {
        setFields([
          { id: "1", name: "txtTaxpayerName", type: "text", x: 10, y: 14.5, w: 42, h: 2.8, page: 1 },
          { id: "2", name: "txtBusinessName", type: "text", x: 10, y: 19.5, w: 42, h: 2.8, page: 1 },
          { id: "3", name: "chkIndividualSole", type: "checkbox", x: 10.5, y: 24.8, w: 1.8, h: 1.4, page: 1 },
          { id: "4", name: "chkCCorporation", type: "checkbox", x: 23.5, y: 24.8, w: 1.8, h: 1.4, page: 1 },
          { id: "5", name: "chkSCorporation", type: "checkbox", x: 33.5, y: 24.8, w: 1.8, h: 1.4, page: 1 },
          { id: "6", name: "txtAddressLine", type: "text", x: 10, y: 34.5, w: 42, h: 2.8, page: 1 },
          { id: "7", name: "txtCityStateZip", type: "text", x: 10, y: 40.5, w: 42, h: 2.8, page: 1 },
          { id: "8", name: "txtEmployerTin", type: "text", x: 58, y: 56.0, w: 32, h: 3.2, page: 1 },
          { id: "9", name: "imgOwnerSignature", type: "image", x: 28, y: 73.5, w: 45, h: 4.5, page: 1 },
          { id: "10", name: "txtSigningDate", type: "text", x: 78, y: 74.2, w: 12, h: 2.5, page: 1 }
        ]);
      } else if (templateId === "sub") {
        setFields([
          { id: "21", name: "txtInvestorName", type: "text", x: 22, y: 18.2, w: 52, h: 2.8, page: 1 },
          { id: "22", name: "txtInvestorEmail", type: "text", x: 22, y: 23.8, w: 52, h: 2.8, page: 1 },
          { id: "23", name: "chkQualifiedInvestor", type: "checkbox", x: 15.5, y: 31.8, w: 2.0, h: 1.5, page: 1 },
          { id: "24", name: "txtCommitmentAmount", type: "text", x: 35, y: 38.5, w: 38, h: 2.8, page: 1 },
          { id: "25", name: "imgAuthorizedSignature", type: "image", x: 25, y: 52.0, w: 42, h: 4.8, page: 1 },
          { id: "26", name: "txtSignatureDate", type: "text", x: 74, y: 53.0, w: 14, h: 2.5, page: 1 }
        ]);
      }
      setSelectedFieldId(null);
    }
  }, [docSource, templateId]);

  // Render trigger - template draw or PDF render
  useEffect(() => {
    if (docSource === "template") {
      drawTemplate();
    } else if (docSource === "image" && uploadedImage) {
      drawImageSource();
    } else if (docSource === "pdf" && pdfFile) {
      renderPdfPage();
    }
  }, [docSource, templateId, uploadedImage, currentPage, pdfFile]);

  // Handle drawing standard high fidelity templates onto canvas
  const drawTemplate = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Fixed Letter PDF point dimensions
    const width = 612;
    const height = 792;
    canvas.width = width;
    canvas.height = height;
    setCanvasDimensions({ width, height });

    // Background Paper color
    ctx.fillStyle = "#FAF9F6";
    ctx.fillRect(0, 0, width, height);

    // Subtle paper edge border shadows mock
    ctx.strokeStyle = "#E2E8F0";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, width, height);

    if (templateId === "w9") {
      // Draw standard simplified tax form layout
      ctx.fillStyle = "#1E293B";
      ctx.font = "bold 14px sans-serif";
      ctx.fillText("Form W-9", 30, 45);
      
      ctx.font = "normal 8px sans-serif";
      ctx.fillText("(Rev. October 2024)", 105, 42);
      ctx.fillText("Department of the Treasury", 30, 58);
      ctx.fillText("Internal Revenue Service", 30, 68);

      ctx.font = "bold 11px sans-serif";
      ctx.fillText("Request for Taxpayer Identification Number and Certification", 170, 45);

      // Section divider lines
      ctx.beginPath();
      ctx.moveTo(30, 80);
      ctx.lineTo(582, 80);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#000000";
      ctx.stroke();

      // Form boxes info
      ctx.font = "normal 9px sans-serif";
      ctx.fillStyle = "#0F172A";

      // Item 1: Name box
      ctx.fillText("1. Name (as shown on your income tax return). Name is required on this line.", 35, 105);
      ctx.beginPath();
      ctx.moveTo(35, 125);
      ctx.lineTo(320, 125);
      ctx.strokeStyle = "#94A3B8";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = "italic 8px sans-serif";
      ctx.fillStyle = "#64748B";
      ctx.fillText("e.g., Johnathan Smith", 35, 122);
      ctx.fillStyle = "#0F172A";
      ctx.font = "normal 9px sans-serif";

      // Item 2: Business name box
      ctx.fillText("2. Business name/disregarded entity name, if different from above.", 35, 145);
      ctx.beginPath();
      ctx.moveTo(35, 165);
      ctx.lineTo(320, 165);
      ctx.stroke();

      // Item 3: Classifications
      ctx.fillText("3. Check appropriate box for federal tax classification of the person whose name is entered on line 1.", 35, 185);
      
      const boxes = [
        { label: "Individual/sole proprietor or single-member LLC", x: 45, y: 200 },
        { label: "C Corporation", x: 45, y: 220 },
        { label: "S Corporation", x: 145, y: 200 },
        { label: "Partnership", x: 145, y: 220 },
        { label: "Trust/estate", x: 235, y: 200 }
      ];

      boxes.forEach(b => {
        ctx.strokeStyle = "#475569";
        ctx.strokeRect(b.x, b.y, 10, 10);
        ctx.font = "normal 8px sans-serif";
        ctx.fillText(b.label, b.x + 15, b.y + 8);
      });

      // Item 5 & 6: Address Layout
      ctx.font = "normal 9px sans-serif";
      ctx.fillText("5. Address (number, street, and apt. or suite no.)", 35, 265);
      ctx.beginPath();
      ctx.moveTo(35, 285);
      ctx.lineTo(320, 285);
      ctx.stroke();

      ctx.fillText("6. City, state, and ZIP code", 35, 305);
      ctx.beginPath();
      ctx.moveTo(35, 325);
      ctx.lineTo(320, 325);
      ctx.stroke();

      // Part I: Taxpayer Identification Number
      ctx.fillStyle = "#F1F5F9";
      ctx.fillRect(30, 370, 552, 20);
      ctx.strokeStyle = "#000000";
      ctx.strokeRect(30, 370, 552, 20);
      ctx.font = "bold 10px sans-serif";
      ctx.fillStyle = "#000000";
      ctx.fillText("Part I", 35, 384);
      ctx.fillText("Taxpayer Identification Number (TIN)", 80, 384);

      ctx.font = "normal 9px sans-serif";
      ctx.fillText("Enter your TIN in the appropriate box. The TIN provided must match the name given on line 1.", 35, 410);
      
      // Social security or EIN Grid mock
      ctx.fillText("Social Security Number (SSN)", 350, 440);
      ctx.strokeRect(350, 450, 190, 22);
      ctx.fillText(" - ", 410, 465);
      ctx.fillText(" - ", 455, 465);

      // Part II: Certification & Signatures
      ctx.fillStyle = "#F1F5F9";
      ctx.fillRect(30, 500, 552, 20);
      ctx.strokeRect(30, 500, 552, 20);
      ctx.font = "bold 10px sans-serif";
      ctx.fillText("Part II", 35, 514);
      ctx.fillText("Certification & Signatures", 80, 514);

      ctx.font = "normal 8px sans-serif";
      ctx.fillText("Under penalties of perjury, I certify that: I am a U.S. citizen or other U.S. person.", 35, 535);
      ctx.fillText("Sign", 35, 565);
      ctx.font = "bold 10px sans-serif";
      ctx.fillText("Here", 35, 575);

      ctx.beginPath();
      ctx.moveTo(70, 590);
      ctx.lineTo(330, 590);
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = "normal 8px sans-serif";
      ctx.fillText("Signature of U.S. person", 70, 600);

      ctx.beginPath();
      ctx.moveTo(350, 590);
      ctx.lineTo(440, 590);
      ctx.stroke();
      ctx.fillText("Date", 350, 600);

      // Bottom Instructions hint
      ctx.font = "italic 8px sans-serif";
      ctx.fillStyle = "#64748B";
      ctx.fillText("Form W-9 (Simplified Visual Template for LLM Field Locator Training)", 30, 770);

    } else {
      // Sub Agreement template
      ctx.fillStyle = "#1F2937";
      ctx.font = "bold 16px serif";
      ctx.fillText("REAL ESTATE INVESTMENTS SUBSCRIPTION AGREEMENT", 40, 50);

      ctx.font = "normal 9px sans-serif";
      ctx.fillStyle = "#4B5563";
      ctx.fillText("SLATE CO-INVESTMENT FUND L.P. - CONFIDENTIAL INVESTOR MEMORANDUM", 40, 66);

      ctx.beginPath();
      ctx.moveTo(40, 75);
      ctx.lineTo(572, 75);
      ctx.strokeStyle = "#D1D5DB";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = "#000000";
      ctx.font = "normal 10px sans-serif";
      ctx.fillText("I. INVESTOR INFORMATION", 40, 105);

      ctx.fillText("Investor Entity / Full Name:", 45, 133);
      ctx.beginPath();
      ctx.moveTo(170, 135);
      ctx.lineTo(500, 135);
      ctx.strokeStyle = "#9CA3AF";
      ctx.stroke();

      ctx.fillText("Contact Person E-Mail Address:", 45, 175);
      ctx.beginPath();
      ctx.moveTo(170, 177);
      ctx.lineTo(500, 177);
      ctx.stroke();

      ctx.font = "normal 10px sans-serif";
      ctx.fillText("II. QUALIFIED INVESTOR STATUS", 40, 225);
      ctx.strokeRect(45, 243, 10, 10);
      ctx.fillText("The undersigned hereby certifies that it constitutes an 'Accredited Investor' as defined", 65, 251);
      ctx.fillText("under Regulation D, Rule 501 of the Securities Act of 1933, as amended.", 65, 263);

      ctx.fillText("Commitment Amount (USD):", 45, 298);
      ctx.beginPath();
      ctx.moveTo(175, 300);
      ctx.lineTo(350, 300);
      ctx.stroke();

      ctx.font = "normal 10px sans-serif";
      ctx.fillText("III. SIGNATURE OF SUBSCRIBER", 40, 370);
      ctx.font = "normal 9px sans-serif";
      ctx.fillText("Executed at Slate Investments Co., as of the date written below.", 40, 390);

      ctx.strokeRect(40, 405, 532, 105);
      ctx.fillText("Investor Entity Signature Name:", 50, 440);
      ctx.beginPath();
      ctx.moveTo(180, 442);
      ctx.lineTo(400, 442);
      ctx.stroke();

      ctx.fillText("Signature Date:", 420, 440);
      ctx.beginPath();
      ctx.moveTo(485, 442);
      ctx.lineTo(560, 442);
      ctx.stroke();

      // Guidelines notes
      ctx.font = "italic 8px sans-serif";
      ctx.fillStyle = "#6B7280";
      ctx.fillText("Disclaimer: This tool detects correct points mappings dynamically using server-side Gemini API inference.", 40, 760);
    }
  };

  // Render Client Uploaded Image
  const drawImageSource = () => {
    const canvas = canvasRef.current;
    if (!canvas || !uploadedImage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.src = uploadedImage;
    img.onload = () => {
      // Scale coordinates to realistic aspect ratios
      const maxW = 612;
      const aspect = img.height / img.width;
      const width = maxW;
      const height = Math.round(maxW * aspect);

      canvas.width = width;
      canvas.height = height;
      setCanvasDimensions({ width, height });
      setPdfPoints({ width, height }); // treat point boundaries same as image dimensions

      ctx.drawImage(img, 0, 0, width, height);
    };
  };

  // Setup PDF.js renderer for current PDF page
  const renderPdfPage = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfFile) return;

    try {
      const pdfjsLib = await loadPdfJs();
      const fileReader = new FileReader();

      fileReader.onload = async (e) => {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        if (!arrayBuffer) return;

        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        setPdfPagesCount(pdf.numPages);

        const page = await pdf.getPage(currentPage);
        const viewport = page.getViewport({ scale: 1.0 });

        // Accurate page sizes in PDF Points
        setPdfPoints({ width: viewport.width, height: viewport.height });

        // Let's render at high resolution on canvas
        const outputWidth = 612;
        const scale = outputWidth / viewport.width;
        const scaledViewport = page.getViewport({ scale });

        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        setCanvasDimensions({ width: scaledViewport.width, height: scaledViewport.height });

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const renderContext = {
          canvasContext: ctx,
          viewport: scaledViewport,
        };

        await page.render(renderContext).promise;
      };

      fileReader.readAsArrayBuffer(pdfFile);
    } catch (err: any) {
      setErrorMessage("Error rendering PDF pages: " + err.message);
    }
  };

  // Handle Dynamic File Upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMessage(null);
    setFields([]);
    setSelectedFieldId(null);

    if (file.type === "application/pdf") {
      setPdfFile(file);
      setDocSource("pdf");
      setCurrentPage(1);
    } else if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setUploadedImage(event.target.result as string);
          setDocSource("image");
        }
      };
      reader.readAsDataURL(file);
    } else {
      setErrorMessage("Unsupported file type. Please upload a standard PDF or scanned image (PNG, JPG).");
    }
  };

  const triggerUploadClick = () => {
    fileInputRef.current?.click();
  };

  // Reset to default sample templates
  const selectTemplate = (id: "w9" | "sub") => {
    setDocSource("template");
    setTemplateId(id);
    setPdfFile(null);
    setUploadedImage(null);
    setErrorMessage(null);
  };

  // Auto detect fields with Gemini API (Visual multimodal)
  const autoDetectFieldsWithLLM = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setIsAnalyzing(true);
    setErrorMessage(null);

    try {
      // Capture the current rendered canvas screen buffer as base64 to send to Gemini
      let imageBase64 = canvas.toDataURL("image/png");

      if (cropRect) {
        // Slices off a precise bounding area of the document and sets it as active focus
        const tempCanvas = document.createElement("canvas");
        const tempCtx = tempCanvas.getContext("2d");
        if (tempCtx) {
          const cropX = (cropRect.x / 100) * canvas.width;
          const cropY = (cropRect.y / 100) * canvas.height;
          const cropW = (cropRect.w / 100) * canvas.width;
          const cropH = (cropRect.h / 100) * canvas.height;

          // Prevent 0 width/height errors
          if (cropW > 1 && cropH > 1) {
            tempCanvas.width = cropW;
            tempCanvas.height = cropH;
            tempCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
            imageBase64 = tempCanvas.toDataURL("image/png");
          }
        }
      }

      const response = await fetch("/api/detect-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: imageBase64,
          pageNum: currentPage,
          pageDimensions: pdfPoints
        })
      });

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error);
      }

      if (data.fields && Array.isArray(data.fields)) {
        // Map detected fields from percentages of the cropped area back to global page coordinates
        const detectedFields: FormField[] = data.fields.map((f: any, idx: number) => {
          let fx = f.x;
          let fy = f.y;
          let fw = f.w;
          let fh = f.h;

          if (cropRect) {
            // Map relative local cropped bounding percentage to original raw global coordinates
            fx = cropRect.x + (f.x / 100) * cropRect.w;
            fy = cropRect.y + (f.y / 100) * cropRect.h;
            fw = (f.w / 100) * cropRect.w;
            fh = (f.h / 100) * cropRect.h;
          }

          return {
            id: `gemini-${Date.now()}-${idx}`,
            name: f.name || `txtField${idx + 1}`,
            type: f.type || "text",
            x: Number(Math.max(0, Math.min(100, fx)).toFixed(2)),
            y: Number(Math.max(0, Math.min(100, fy)).toFixed(2)),
            w: Number(Math.max(0.5, Math.min(100, fw)).toFixed(2)),
            h: Number(Math.max(0.5, Math.min(100, fh)).toFixed(2)),
            page: currentPage
          };
        });

        setFields(detectedFields);
        setSelectedFieldId(detectedFields[0]?.id || null);
        // Turn off crop mode after successful active focusing
        setCropModeActive(false);
      } else {
        throw new Error("Invalid response format from server-side analyzer.");
      }
    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message || "Failed to analyze page using GenAI.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Visual Overlay Actions (Drag and Drop, Resizing)
  const handleInteractionMouseDown = (
    e: React.MouseEvent,
    field: FormField,
    action: "drag" | "resize"
  ) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedFieldId(field.id);

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    setDragState({
      id: field.id,
      action,
      startX: clientX,
      startY: clientY,
      originalX: field.x,
      originalY: field.y,
      originalW: field.w,
      originalH: field.h
    });
  };

  // Dynamic Drawing of New Fields holding Shift on empty canvas area
  const handleCanvasContainerMouseDown = (e: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;

    // Detect if we clicked empty space inside the sheet overlay
    if (e.target === container || (e.target as HTMLElement).id === "canvas-overlay" || cropModeActive) {
      e.preventDefault();
      setSelectedFieldId(null);

      const rect = container.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      // Convert pixels to percentages
      const pctX = (clickX / rect.width) * 100;
      const pctY = (clickY / rect.height) * 100;

      if (cropModeActive) {
        // Start dragging selection layout for crop box
        setDragState({
          id: "crop-drag-action",
          action: "draw",
          startX: clickX,
          startY: clickY,
          originalX: pctX,
          originalY: pctY,
          originalW: 0,
          originalH: 0
        });
        setCropRect({
          x: pctX,
          y: pctY,
          w: 0,
          h: 0
        });
        return;
      }

      // Create new fresh field
      const newFieldId = `field-${Date.now()}`;
      const newField: FormField = {
        id: newFieldId,
        name: `txtField_${fields.length + 1}`,
        type: "text",
        x: pctX,
        y: pctY,
        w: 12, // default 12% width
        h: 3,  // default 3% height
        page: currentPage
      };

      setFields([...fields, newField]);
      setSelectedFieldId(newFieldId);

      // Start drag adjustment
      setDragState({
        id: newFieldId,
        action: "resize",
        startX: clickX,
        startY: clickY,
        originalX: pctX,
        originalY: pctY,
        originalW: 0,
        originalH: 0
      });
    }
  };

  useEffect(() => {
    const handleMouseUp = () => {
      if (dragState) {
        if (dragState.id === "crop-drag-action") {
          setCropRect((current) => {
            if (current && (current.w < 1 || current.h < 1)) {
              return null;
            }
            return current;
          });
        }
        setDragState(null);
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState) return;
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const currentX = e.clientX - rect.left;
      const currentY = e.clientY - rect.top;

      // Calculations in percentages
      const deltaXPct = ((currentX - dragState.startX) / rect.width) * 100;
      const deltaYPct = ((currentY - dragState.startY) / rect.height) * 100;

      if (dragState.id === "crop-drag-action") {
        const startX = dragState.originalX;
        const startY = dragState.originalY;
        const endX = startX + deltaXPct;
        const endY = startY + deltaYPct;

        const x = Math.max(0, Math.min(100, Math.min(startX, endX)));
        const y = Math.max(0, Math.min(100, Math.min(startY, endY)));
        const w = Math.max(0, Math.min(100 - x, Math.abs(deltaXPct)));
        const h = Math.max(0, Math.min(100 - y, Math.abs(deltaYPct)));

        setCropRect({
          x: Number(x.toFixed(2)),
          y: Number(y.toFixed(2)),
          w: Number(w.toFixed(2)),
          h: Number(h.toFixed(2))
        });
        return;
      }

      setFields((prevFields) =>
        prevFields.map((f) => {
          if (f.id !== dragState.id) return f;

          if (dragState.action === "drag") {
            const newX = Math.max(0, Math.min(100 - f.w, dragState.originalX + deltaXPct));
            const newY = Math.max(0, Math.min(100 - f.h, dragState.originalY + deltaYPct));
            return { ...f, x: Number(newX.toFixed(2)), y: Number(newY.toFixed(2)) };
          } else if (dragState.action === "resize") {
            const newW = Math.max(1.0, Math.min(100 - f.x, dragState.originalW + deltaXPct));
            const newH = Math.max(1.0, Math.min(100 - f.y, dragState.originalH + deltaYPct));
            return { ...f, w: Number(newW.toFixed(2)), h: Number(newH.toFixed(2)) };
          }
          return f;
        })
      );
    };

    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("mousemove", handleMouseMove);

    return () => {
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, [dragState]);

  // Keyboard Delete Selected Field
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (selectedFieldId && (e.key === "Delete" || e.key === "Backspace")) {
        // Only trigger if we aren't editing a text input
        if (document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "SELECT") {
          deleteField(selectedFieldId);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedFieldId]);

  // Edit fields operations
  const updateFieldProperty = (id: string, property: keyof FormField, value: any) => {
    setFields((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        const updated = { ...f, [property]: value };
        
        // Auto suffix correction to follow naming guidelines strictly
        if (property === "name") {
          // ensure no whitespace
          updated.name = value.replace(/\s+/g, "");
        }
        if (property === "type") {
          // enforce prefix convention automatically
          const baseName = f.name.replace(/^(txt|chk|img)/, "");
          const prefix = value === "checkbox" ? "chk" : value === "image" ? "img" : "txt";
          const firstCharLower = prefix;
          const camelRest = baseName.charAt(0).toUpperCase() + baseName.slice(1);
          updated.name = firstCharLower + (baseName ? camelRest : "ValidatedField");
        }
        return updated;
      })
    );
  };

  const deleteField = (id: string) => {
    setFields(prev => prev.filter(f => f.id !== id));
    if (selectedFieldId === id) {
      setSelectedFieldId(null);
    }
  };

  const addNewCustomField = () => {
    const newId = `custom-${Date.now()}`;
    const newField: FormField = {
      id: newId,
      name: `txtNewField_${fields.length + 1}`,
      type: "text",
      x: 15,
      y: 15,
      w: 25,
      h: 3,
      page: currentPage
    };
    setFields([...fields, newField]);
    setSelectedFieldId(newId);
  };

  // Convert Percentage to Bottom-Left PDF points matching xdp-form-cli structure
  const convertToPdfCoordinates = (f: FormField) => {
    // Width and height of PDF page in points (e.g. 612 x 792)
    const pw = pdfPoints.width;
    const ph = pdfPoints.height;

    const x = Math.round((f.x / 100) * pw);
    // Remember PDF y-axis is from BOTTOM-LEFT.
    // CSS y percentage goes from top down.
    // So bottom of field in PDF coordinates is: ph - (y_percentage + h_percentage)% of ph
    const y = Math.round((1 - (f.y + f.h) / 100) * ph);
    const w = Math.round((f.w / 100) * pw);
    const h = Math.round((f.h / 100) * ph);

    return { x, y, w, h };
  };

  // Generate Field-Spec CSV contents
  const generateCsvContent = () => {
    const header = "page,name,type,x,y,w,h,value";
    const rows = fields.map((f) => {
      const { x, y, w, h } = convertToPdfCoordinates(f);
      const val = f.type === "checkbox" ? "0" : "";
      return `${currentPage},${f.name},${f.type},${x},${y},${w},${h},${val}`;
    });
    return [header, ...rows].join("\n");
  };

  // Copy CSV contents to clipboard
  const copyToClipboard = () => {
    const cv = generateCsvContent();
    navigator.clipboard.writeText(cv);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  // Download real file
  const downloadCsvFile = () => {
    const csvContent = generateCsvContent();
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `xdp_fields_page_${currentPage}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans flex flex-col antialiased">
      {/* Crisp High-Contrast Premium Header */}
      <header className="bg-white border-b border-slate-200 py-4 px-6 sticky top-0 z-40 shadow-xs flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 text-white p-2 rounded-lg flex items-center justify-center shadow-sm">
            <FileSpreadsheet className="w-5 h-5" id="header_icon" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-900 tracking-tight font-sans">
              PDF Form Field Locator
            </h1>
            <p className="text-xs text-slate-500 font-medium">
              Vite-powered visual WYSIWYG helper for XDP/AcroForm spec mapping
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs bg-slate-100 py-1.5 px-3 rounded-full font-medium">
            <span className={`w-2 h-2 rounded-full ${serverConnected ? "bg-emerald-500" : "bg-rose-500"}`} />
            <span className="text-slate-600">{serverConnected ? "LLM Server Connection Ready" : "Server Disconnected"}</span>
          </div>
        </div>
      </header>

      {/* Main Grid Workspace */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN: Visual Document Workspace (8 cols) */}
        <div className="lg:col-span-8 flex flex-col gap-4">
          
          {/* Workstation Toolbar */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs flex flex-wrap gap-4 items-center justify-between">
            {/* Input Picker Selection Options */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider mr-1">SOURCE:</span>
              <button 
                id="btn_source_template"
                onClick={() => selectTemplate("w9")}
                className={`py-1.5 px-3 rounded-lg text-xs font-semibold transition-all ${docSource === "template" && templateId === "w9" ? "bg-slate-900 text-white shadow-xs" : "bg-slate-100 hover:bg-slate-200 text-slate-700"}`}
              >
                Sample W-9 IRS Form
              </button>
              <button 
                id="btn_source_sec"
                onClick={() => selectTemplate("sub")}
                className={`py-1.5 px-3 rounded-lg text-xs font-semibold transition-all ${docSource === "template" && templateId === "sub" ? "bg-slate-900 text-white shadow-xs" : "bg-slate-100 hover:bg-slate-200 text-slate-700"}`}
              >
                Sample Sub Agreement
              </button>
              <button 
                id="btn_trigger_upload"
                onClick={triggerUploadClick}
                className={`py-1.5 px-3 rounded-lg text-xs font-semibold transition-all flex items-center gap-1 ${docSource === "pdf" || docSource === "image" ? "bg-blue-600 text-white shadow-xs" : "bg-slate-100 hover:bg-slate-200 text-slate-700"}`}
              >
                <Upload className="w-3.5 h-3.5" />
                Upload PDF / Image File
              </button>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileUpload} 
                accept="application/pdf,image/*" 
                className="hidden" 
              />

              {/* Crop Tools Selector */}
              <div className="flex items-center gap-1.5 border-l border-slate-200 pl-3">
                <button
                  id="btn_crop_mode"
                  onClick={() => {
                    setCropModeActive(!cropModeActive);
                  }}
                  className={`py-1.5 px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${cropModeActive ? "bg-amber-500 text-white shadow-xs" : cropRect ? "bg-blue-50 border border-blue-200 text-blue-700" : "bg-slate-100 hover:bg-slate-200 text-slate-700"}`}
                  title="Specify a crop bounded focus area specifically ignoring third party borders"
                >
                  <Crop className="w-3.5 h-3.5" />
                  <span>{cropRect ? "Active Focus Mask" : "Focus / Crop Area"}</span>
                </button>
                {cropRect && (
                  <button
                    id="btn_clear_crop"
                    onClick={() => {
                      setCropRect(null);
                      setCropModeActive(false);
                    }}
                    className="text-xs bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 py-1.5 px-2 rounded-lg font-semibold flex items-center transition-colors"
                    title="Clear focusing mask"
                  >
                    Cancel Crop
                  </button>
                )}
              </div>
            </div>

            {/* AI Call Button */}
            <div className="flex items-center gap-2">
              <button 
                id="btn_ai_detect"
                onClick={autoDetectFieldsWithLLM}
                disabled={isAnalyzing || !serverConnected}
                className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 font-semibold disabled:from-slate-400 disabled:to-slate-400 text-white px-4 py-1.5 rounded-lg text-xs shadow-md shadow-blue-500/10 flex items-center gap-1.5 transition-all transform active:scale-95 duration-100"
              >
                {isAnalyzing ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                {isAnalyzing ? "Analyzing Page..." : "⚡ Detect Fields with Gemini"}
              </button>
            </div>
          </div>

          {/* Interactive Document Sheet Canvas */}
          <div className="bg-slate-200/60 rounded-2xl border border-slate-200 p-6 flex justify-center items-center overflow-auto min-h-[500px] relative group shadow-inner">
            
            {/* Loading/In-Progress State overlay */}
            <AnimatePresence>
              {isAnalyzing && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 bg-white/70 backdrop-blur-xs z-30 flex flex-col justify-center items-center gap-4"
                >
                  <div className="flex justify-center items-center gap-2">
                    <span className="w-3 h-3 bg-blue-600 rounded-full animate-bounce [animation-delay:-0.3s]" />
                    <span className="w-3 h-3 bg-blue-600 rounded-full animate-bounce [animation-delay:-0.15s]" />
                    <span className="w-3 h-3 bg-blue-600 rounded-full animate-bounce" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-semibold text-slate-800">Gemini is analyzing page layout visually</p>
                    <p className="text-xs text-slate-500 mt-1 max-w-sm px-6">Measuring precise coordinate bounding boxes, input lines, text boxes, and labels...</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Error Message banner */}
            <AnimatePresence>
              {errorMessage && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="absolute top-4 left-4 right-4 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg flex items-start gap-2.5 z-20 text-xs shadow-md shadow-amber-900/5 font-medium"
                >
                  <AlertCircle className="w-4.5 h-4.5 text-amber-600 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    {errorMessage}
                  </div>
                  <button onClick={() => setErrorMessage(null)} className="text-amber-500 hover:text-amber-800 ml-2 font-bold select-none cursor-pointer">×</button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Canvas scale wrapper */}
            <div 
              style={{ transform: `scale(${zoomScale})`, transformOrigin: "center center" }}
              className="relative transition-transform duration-300"
            >
              <div 
                ref={containerRef}
                onMouseDown={handleCanvasContainerMouseDown}
                className="relative bg-white shadow-xl select-none cursor-crosshair overflow-hidden border border-slate-300/80 rounded-sm"
                style={{ 
                  width: `${canvasDimensions.width}px`, 
                  height: `${canvasDimensions.height}px` 
                }}
              >
                {/* Physical Render Canvas */}
                <canvas ref={canvasRef} className="absolute inset-0 z-0 pointer-events-none" />

                {/* Crop help guide when crop mode is active but box not drawn yet */}
                {cropModeActive && !cropRect && (
                  <div className="absolute inset-0 bg-blue-600/5 backdrop-blur-3xs z-[18] pointer-events-none flex items-center justify-center">
                    <div className="bg-slate-900/95 text-white rounded-xl px-5 py-3 text-xs font-semibold shadow-xl text-center flex items-center gap-2.5 max-w-sm animate-pulse border border-blue-500/30">
                      <Crop className="w-4.5 h-4.5 text-blue-400 rotate-12" />
                      <span>Click & drag on the document to select your crop region</span>
                    </div>
                  </div>
                )}

                {/* Form fields drawing/selection overlay layer */}
                <div id="canvas-overlay" className="absolute inset-0 z-10">
                  {fields.map((f) => {
                    const isSelected = f.id === selectedFieldId;
                    
                    // Box colors mapping per type
                    const colors = {
                      text: { bg: "bg-blue-500/15", border: "border-blue-500", text: "text-blue-700" },
                      textarea: { bg: "bg-indigo-500/15", border: "border-indigo-500", text: "text-indigo-700" },
                      checkbox: { bg: "bg-emerald-500/15", border: "border-emerald-500", text: "text-emerald-700" },
                      image: { bg: "bg-amber-500/15", border: "border-amber-500", text: "text-amber-700" }
                    };
                    const color = colors[f.type] || colors.text;

                    return (
                      <div
                        id={`field_overlay_${f.id}`}
                        key={f.id}
                        style={{
                          left: `${f.x}%`,
                          top: `${f.y}%`,
                          width: `${f.w}%`,
                          height: `${f.h}%`,
                        }}
                        className={`absolute border-2 ${color.bg} ${color.border} ${isSelected ? "ring-2 ring-blue-400 ring-offset-1 z-20" : "z-10"} group hover:shadow-md cursor-move flex items-center justify-center transition-shadow overflow-hidden rounded-sm ${cropModeActive ? "pointer-events-none" : ""}`}
                        onMouseDown={(e) => handleInteractionMouseDown(e, f, "drag")}
                      >
                        {/* Selected overlay item text label */}
                        <div className="absolute top-0.5 left-1 max-w-[90%] truncate pointer-events-none">
                          <span className={`text-[9px] font-bold ${color.text} font-mono bg-white/90 px-1 rounded shadow-2xs`}>
                            {f.name}
                          </span>
                        </div>

                        {/* Top corner quick delete button */}
                        {isSelected && (
                          <button
                            id={`btn_delete_${f.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteField(f.id);
                            }}
                            className="absolute bottom-0.5 right-1 bg-white hover:bg-rose-50 text-rose-500 hover:text-rose-700 p-0.5 rounded shadow-xs border border-slate-200 transition-colors z-30 cursor-pointer"
                            title="Delete Field"
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                          </button>
                        )}

                        {/* Resizer corner control handle bottom-right */}
                        {isSelected && (
                          <div
                            id={`resizer_${f.id}`}
                            className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-blue-600 border border-white cursor-se-resize flex items-center justify-center rounded-tl-md shadow-xs z-30"
                            onMouseDown={(e) => handleInteractionMouseDown(e, f, "resize")}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Highlight Crop Area & Dark Shroud overlay */}
                {cropRect && (
                  <div className="absolute inset-0 z-20 pointer-events-none">
                    {/* Dark Shrouds */}
                    <div 
                      className="absolute bg-slate-900/60 transition-all duration-100" 
                      style={{ top: 0, left: 0, right: 0, height: `${cropRect.y}%` }} 
                    />
                    <div 
                      className="absolute bg-slate-900/60 transition-all duration-100" 
                      style={{ top: `${cropRect.y + cropRect.h}%`, left: 0, right: 0, bottom: 0 }} 
                    />
                    <div 
                      className="absolute bg-slate-900/60 transition-all duration-100" 
                      style={{ top: `${cropRect.y}%`, left: 0, width: `${cropRect.x}%`, height: `${cropRect.h}%` }} 
                    />
                    <div 
                      className="absolute bg-slate-900/60 transition-all duration-100" 
                      style={{ top: `${cropRect.y}%`, left: `${cropRect.x + cropRect.w}%`, right: 0, height: `${cropRect.h}%` }} 
                    />

                    {/* Crop Border Box */}
                    <div 
                      className="absolute border-2 border-dashed border-blue-500 shadow-xl ring-2 ring-blue-500/20"
                      style={{
                        left: `${cropRect.x}%`,
                        top: `${cropRect.y}%`,
                        width: `${cropRect.w}%`,
                        height: `${cropRect.h}%`,
                      }}
                    >
                      {/* Crop Label Badges */}
                      <div className="absolute top-2 left-2 bg-blue-600 text-white font-bold px-1.5 py-0.5 rounded text-[8px] tracking-wide uppercase shadow-md flex items-center gap-1">
                        <Crop className="w-2.5 h-2.5" />
                        <span>Focused Region ({Math.round(cropRect.w)}% × {Math.round(cropRect.h)}%)</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Navigation Controls Block */}
          <div className="flex justify-between items-center bg-white border border-slate-200 rounded-xl p-3 shadow-xs">
            {/* Page Nav */}
            <div className="flex items-center gap-3">
              {docSource === "pdf" && pdfPagesCount > 1 ? (
                <div className="flex items-center gap-2">
                  <button 
                    id="btn_prev_page"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-xs font-semibold text-slate-600">
                    Page {currentPage} of {pdfPagesCount}
                  </span>
                  <button
                    id="btn_next_page"
                    disabled={currentPage >= pdfPagesCount}
                    onClick={() => setCurrentPage(p => Math.min(pdfPagesCount, p + 1))}
                    className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 transition-colors"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-slate-500 font-medium">
                  <FileText className="w-4 h-4 text-slate-400" />
                  <span>Interactive Spec Canvas Layout (Point dimensions: {pdfPoints.width}x{pdfPoints.height})</span>
                </div>
              )}
            </div>

            {/* Quick Action Hints */}
            <div className="text-xxs text-slate-400 font-semibold uppercase tracking-wider hidden sm:block">
              🖱️ Drag to Move | Drag corner handle to Resize | Click holding Shift/Empty space to draw
            </div>

            {/* Zoom Widget */}
            <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg">
              <button 
                id="btn_zoom_out"
                onClick={() => setZoomScale(s => Math.max(0.6, s - 0.1))}
                className="p-1 hover:bg-white rounded-md text-slate-600 transition-colors"
                title="Zoom Out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="text-[10px] font-bold font-mono text-slate-700 min-w-10 text-center">
                {Math.round(zoomScale * 100)}%
              </span>
              <button 
                id="btn_zoom_in"
                onClick={() => setZoomScale(s => Math.min(1.5, s + 0.1))}
                className="p-1 hover:bg-white rounded-md text-slate-600 transition-colors"
                title="Zoom In"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Field Editor, Tabular spreadsheet, CSV generator (4 cols) */}
        <div className="lg:col-span-4 flex flex-col gap-6">

          {/* Collapsible/Tab Header */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col gap-4">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h2 className="font-semibold text-slate-900 flex items-center gap-2">
                <FileText className="w-4.5 h-4.5 text-blue-600" />
                Active Field Inspector
              </h2>
              <button
                id="btn_add_field"
                onClick={addNewCustomField}
                className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 py-1.5 px-2.5 rounded-lg font-semibold flex items-center gap-1 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> New Field
              </button>
            </div>

            {selectedFieldId ? (
              fields.filter(f => f.id === selectedFieldId).map((field) => {
                const pdfCoords = convertToPdfCoordinates(field);

                return (
                  <div key={field.id} className="flex flex-col gap-4 text-xs">
                    {/* Field Type Radio Picker */}
                    <div className="flex flex-col gap-1.5">
                      <label className="font-medium text-slate-500">Field Type</label>
                      <div className="grid grid-cols-4 gap-1 p-0.5 bg-slate-100 rounded-lg">
                        {(["text", "textarea", "checkbox", "image"] as const).map(t => (
                          <button
                            id={`radio_type_${t}_${field.id}`}
                            key={t}
                            onClick={() => updateFieldProperty(field.id, "type", t)}
                            className={`py-1 rounded-md text-[10px] font-bold uppercase tracking-wide transition-all ${field.type === t ? "bg-white text-blue-600 shadow-2xs" : "text-slate-500 hover:text-slate-800"}`}
                          >
                            {t === "image" ? "Sign/Img" : t}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Field Name Input */}
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="inspector-field-name" className="font-medium text-slate-500">Field Name</label>
                      <input
                        id="inspector-field-name"
                        type="text"
                        value={field.name}
                        onChange={(e) => updateFieldProperty(field.id, "name", e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 p-2 rounded-lg text-slate-800 font-mono focus:border-blue-400 focus:ring-1 focus:ring-blue-400 outline-hidden font-bold"
                      />
                    </div>

                    {/* Coordinates Readout Grid (Points & Percentages) */}
                    <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-100">
                      <div>
                        <span className="text-[10px] uppercase font-bold text-slate-400 block mb-1">PDF points (Bottom-Left)</span>
                        <div className="font-mono text-slate-700 font-semibold space-y-1">
                          <div>x: <span className="text-slate-900">{pdfCoords.x}</span></div>
                          <div>y: <span className="text-slate-900">{pdfCoords.y}</span></div>
                          <div>w: <span className="text-slate-900">{pdfCoords.w}</span></div>
                          <div>h: <span className="text-slate-900">{pdfCoords.h}</span></div>
                        </div>
                      </div>
                      <div>
                        <span className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Canvas % (Top-Left)</span>
                        <div className="font-mono text-slate-700 font-semibold space-y-1">
                          <div>x: <span className="text-slate-900">{field.x}%</span></div>
                          <div>y: <span className="text-slate-900">{field.y}%</span></div>
                          <div>w: <span className="text-slate-900">{field.w}%</span></div>
                          <div>h: <span className="text-slate-900">{field.h}%</span></div>
                        </div>
                      </div>
                    </div>

                    {/* Quick Arial Font indicator */}
                    <div className="flex items-center gap-2 text-[11px] text-slate-500 font-semibold bg-emerald-50 text-emerald-800 border border-emerald-100 py-1.5 px-2.5 rounded-lg">
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Arial font automatically forced on output</span>
                    </div>

                    {/* Action buttons inside Inspector */}
                    <button
                      id={`btn_delete_inspector_${field.id}`}
                      onClick={() => deleteField(field.id)}
                      className="w-full border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Remove Field
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="py-8 text-center text-slate-400 flex flex-col items-center justify-center gap-2">
                <Info className="w-8 h-8 text-slate-300" />
                <p className="text-xs font-medium">No component selected on page</p>
                <p className="text-xxs text-slate-400 mt-1 max-w-[200px]">Click any overlaid item, create a new one, or click empty page canvas space to start drawing field spec.</p>
              </div>
            )}
          </div>

          {/* Fields List Spreadsheet Block */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col gap-3">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2 border-b border-slate-100 pb-2">
              <Layers className="w-4.5 h-4.5 text-blue-600" id="fields_list_icon" />
              Spreadsheet View ({fields.length})
            </h2>

            {fields.length > 0 ? (
              <div className="max-h-[220px] overflow-y-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse text-[11px]" id="fields_table">
                  <thead className="bg-slate-50 border-b border-slate-200 text-[10px] text-slate-400 uppercase font-bold sticky top-0">
                    <tr>
                      <th className="p-2">Name</th>
                      <th className="p-2">Type</th>
                      <th className="p-2 text-right">Points (X, Y, W, H)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {fields.map((f) => {
                      const isSelected = f.id === selectedFieldId;
                      const { x, y, w, h } = convertToPdfCoordinates(f);

                      return (
                        <tr 
                          id={`row_${f.id}`}
                          key={f.id}
                          className={`hover:bg-slate-50 cursor-pointer ${isSelected ? "bg-blue-50/70 text-blue-900 font-semibold" : "text-slate-600"}`}
                          onClick={() => setSelectedFieldId(f.id)}
                        >
                          <td className="p-2 truncate font-mono max-w-[120px]">{f.name}</td>
                          <td className="p-2">
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full capitalize font-semibold bg-slate-100">
                              {f.type}
                            </span>
                          </td>
                          <td className="p-2 font-mono text-right text-[10px]">
                            {x}, {y}, {w}, {h}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-slate-400 text-center py-6">No fields defined yet on this page.</p>
            )}
          </div>

          {/* Raw Export CSV Block */}
          <div className="bg-slate-950 text-slate-100 rounded-2xl p-5 shadow-lg relative overflow-hidden flex flex-col gap-3">
            <div className="flex justify-between items-center border-b border-slate-800 pb-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Download className="w-4 h-4 text-emerald-400" />
                Raw Field-Spec CSV
              </h2>
              <div className="flex items-center gap-2">
                <button
                  id="btn_copy_csv"
                  onClick={copyToClipboard}
                  className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg hover:text-white transition-colors"
                  title="Copy to Clipboard"
                >
                  {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
                <button
                  id="btn_download_csv"
                  onClick={downloadCsvFile}
                  className="bg-emerald-600 hover:bg-emerald-700 font-bold text-white text-[10px] uppercase tracking-wide py-1 px-2 rounded-lg flex items-center gap-1 transition-colors"
                  title="Download File-spec CSV"
                >
                  <Download className="w-3 h-3" /> Export
                </button>
              </div>
            </div>

            <div className="bg-slate-900 rounded-lg p-3 font-mono text-[10px] text-zinc-300 overflow-x-auto whitespace-pre leading-relaxed select-all max-h-[160px] overflow-y-auto">
              {generateCsvContent()}
            </div>
            <div className="text-[9px] text-slate-500 text-center leading-relaxed font-sans">
              Matches format required by <code className="text-slate-400 bg-slate-900 px-1 py-0.2 rounded font-mono">xdp-form-cli create-acroform</code> command.
            </div>
          </div>

        </div>
      </main>

      {/* Elegant minimalist footer */}
      <footer className="bg-white border-t border-slate-200 mt-auto py-4 text-center text-xs text-slate-400 font-medium">
        PDF Form Field Locator &copy; {new Date().getFullYear()} &middot; Built with Gemini 3.5 Flash visual intelligence
      </footer>
    </div>
  );
}
