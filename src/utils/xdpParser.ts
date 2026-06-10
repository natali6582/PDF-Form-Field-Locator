import { PDFDocument, PDFDict, PDFArray, PDFStream, PDFName } from "pdf-lib";

export interface ParsedXFAField {
  name: string;
  type: "text" | "textarea" | "checkbox" | "image" | "button";
  x: number; // PDF Points
  y: number; // PDF Points
  w: number; // PDF Points
  h: number; // PDF Points
  label: string;
  page: number;
}

// Convert measurements (mm, in, cm, pt) to raw PDF Points
export function parseMeasurement(val: string | null): number {
  if (!val) return 0;
  const trimmed = val.trim();
  const num = parseFloat(trimmed);
  if (isNaN(num)) return 0;

  if (trimmed.endsWith("mm")) {
    return num * 2.83464;
  }
  if (trimmed.endsWith("in")) {
    return num * 72;
  }
  if (trimmed.endsWith("cm")) {
    return num * 28.3464;
  }
  if (trimmed.endsWith("pt")) {
    return num;
  }
  return num; // Default to point values
}

/**
 * Detects XFA/XDP data and extracts the uncompressed template XML block,
 * parsing all form field coordinates, labels, and pages.
 */
export async function extractAndParseXFA(pdfArrayBuffer: ArrayBuffer): Promise<{
  xfaDetected: boolean;
  rawXml: string;
  fields: ParsedXFAField[];
}> {
  try {
    const pdfDoc = await PDFDocument.load(pdfArrayBuffer);
    const catalog = pdfDoc.catalog;
    const acroForm = catalog.get(PDFName.of("AcroForm"));
    
    let rawXml = "";
    let xfaDetected = false;

    if (acroForm instanceof PDFDict) {
      const xfa = acroForm.get(PDFName.of("XFA"));
      if (xfa) {
        xfaDetected = true;
        const resolvedXfa = pdfDoc.context.lookup(xfa);
        
        if (resolvedXfa instanceof PDFStream) {
          rawXml = new TextDecoder("utf-8", { fatal: false }).decode(
            (resolvedXfa as any).getUncompressedContents()
          );
        } else if (resolvedXfa instanceof PDFArray) {
          const array = resolvedXfa.asArray();
          for (let i = 1; i < array.length; i += 2) {
            const item = pdfDoc.context.lookup(array[i]);
            if (item instanceof PDFStream) {
              const textChunk = new TextDecoder("utf-8", { fatal: false }).decode(
                (item as any).getUncompressedContents()
              );
              rawXml += textChunk;
            }
          }
        }
      }
    }

    // Fallback: If pdf-lib dictionary is missing but binary contains raw xdp tag
    if (!xfaDetected || !rawXml) {
      const textDecoder = new TextDecoder("utf-8", { fatal: false });
      const fullText = textDecoder.decode(pdfArrayBuffer);
      const startIdx = fullText.indexOf("<xdp:xdp");
      if (startIdx !== -1) {
        const endIdx = fullText.indexOf("</xdp:xdp>", startIdx);
        if (endIdx !== -1) {
          xfaDetected = true;
          rawXml = fullText.substring(startIdx, endIdx + "</xdp:xdp>".length);
        }
      }
    }

    if (!xfaDetected || !rawXml) {
      return { xfaDetected: false, rawXml: "", fields: [] };
    }

    // Parse the extracted XML Stream
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(rawXml, "application/xml");
    
    // We search for subforms to establish page areas
    const fields: ParsedXFAField[] = [];
    let currentPageNum = 1;

    // Helper: Traverse nodes recursively to find fields within numbered subforms (pages)
    const traverse = (node: Node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const elem = node as Element;
        const tagName = elem.tagName.toLowerCase();

        // Increment page count if we see a top-level pageArea or subform matching page layout
        if (tagName === "subform" && (elem.getAttribute("layout") === "pageArea" || elem.getAttribute("name")?.toLowerCase().includes("page"))) {
          // If previous page exists, increment page number
          if (fields.length > 0 && fields[fields.length - 1].page === currentPageNum) {
            currentPageNum++;
          }
        }

        if (tagName === "field") {
          const name = elem.getAttribute("name") || `xfaField_${fields.length + 1}`;
          const xStr = elem.getAttribute("x");
          const yStr = elem.getAttribute("y");
          const wStr = elem.getAttribute("w") || elem.getAttribute("width");
          const hStr = elem.getAttribute("h") || elem.getAttribute("height");

          const x = parseMeasurement(xStr);
          const y = parseMeasurement(yStr);
          const w = parseMeasurement(wStr) || 120; // fallback width
          const h = parseMeasurement(hStr) || 16;  // fallback height

          // Parse Type
          let type: "text" | "textarea" | "checkbox" | "image" | "button" = "text";
          const checkButton = elem.getElementsByTagName("checkButton")[0];
          const signature = elem.getElementsByTagName("signature")[0];
          const textEdit = elem.getElementsByTagName("textEdit")[0];
          const button = elem.getElementsByTagName("button")[0];

          if (checkButton) {
            type = "checkbox";
          } else if (signature) {
            type = "image"; // Maps to standard interactive signature bounds
          } else if (button) {
            type = "button";
          } else if (textEdit) {
            const isMulti = textEdit.getAttribute("multiLine") === "1";
            type = isMulti ? "textarea" : "text";
          }

          // Parse Label/Caption text
          let label = "";
          const caption = elem.getElementsByTagName("caption")[0];
          if (caption) {
            const valueNode = caption.getElementsByTagName("value")[0];
            if (valueNode) {
              const textNode = valueNode.getElementsByTagName("text")[0];
              if (textNode) {
                label = textNode.textContent || "";
              }
            }
          }
          if (!label) {
            label = name.replace(/([A-Z])/g, " $1").trim(); // natural space fallback
          }

          fields.push({
            name,
            type,
            x,
            y,
            w,
            h,
            label,
            page: currentPageNum
          });
        }
      }

      for (let i = 0; i < node.childNodes.length; i++) {
        traverse(node.childNodes[i]);
      }
    };

    traverse(xmlDoc);

    return {
      xfaDetected: true,
      rawXml,
      fields
    };
  } catch (error) {
    console.error("XFA parsing error:", error);
    return { xfaDetected: false, rawXml: "", fields: [] };
  }
}
