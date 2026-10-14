import PDFDocument from "pdfkit";

export function renderResumePdf(resume: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margins: { top: 54, bottom: 54, left: 56, right: 56 },
      info: { Title: "Currículo", Creator: "Curriculus" },
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.once("error", reject);
    document.once("end", () => resolve(Buffer.concat(chunks)));

    document.font("Helvetica").fontSize(10.5).fillColor("#202725");
    document.text(resume, { lineGap: 3, paragraphGap: 4, align: "left" });
    document.end();
  });
}
