export type ResumeLayoutColor = `#${string}`;
export type ResumeLayoutFontFamily = "Helvetica" | "Times-Roman" | "Courier";
export type ResumeLayoutFontWeight = "normal" | "bold";
export type ResumeLayoutSection =
  | "contact"
  | "education"
  | "skills"
  | "languages"
  | "summary"
  | "experience"
  | "certifications"
  | "projects"
  | "other";

type ResumeLayoutTemplateBase = {
  palette: {
    sidebar: ResumeLayoutColor;
    main: "#FFFFFF";
    headerApprox: ResumeLayoutColor;
    text: ResumeLayoutColor;
  };
  sections: string[];
  sidebarSections: string[];
  overflow: {
    wrapText: true;
    pageBreak: true;
    keepExperienceHeadingWithFirstBullet: true;
  };
  detection: {
    confidence: number;
    detectedColumns: 1 | 2;
    warnings: string[];
  };
};

/** Kept readable for analysis sessions created with the original fixed renderer. */
export type ResumeLayoutTemplateV2 = ResumeLayoutTemplateBase & {
  schemaVersion: "2.0";
  id: "sidebar-dark-header-color-v1";
  page: { format: "A4"; widthPt: number; heightPt: number; marginPt: number };
  columns: { sidebarWidthPt: number; gapPt: number; sidebarRepeats: true };
  header: { heightPt: number; nameUppercase: true };
  typography: { namePt: number; sectionPt: number; bodyPt: number };
};

export type ResumeLayoutVisualRegion = {
  role: "sidebar" | "header" | "accent";
  x: number;
  y: number;
  width: number;
  height: number;
  color: ResumeLayoutColor;
  pageNumber: number;
  repeatOnPages: boolean;
};

export type ResumeLayoutTemplateV3 = ResumeLayoutTemplateBase & {
  schemaVersion: "3.0";
  id: "adaptive-resume-layout-v1";
  page: { format: "A4" | "custom"; widthPt: number; heightPt: number; marginPt: number };
  columns: {
    count: 1 | 2;
    sidebarWidthPt: number;
    gapPt: number;
    sidebarRepeats: boolean;
    sidebarSide: "left" | "right";
    sidebarXPt: number;
    mainXPt: number;
    mainWidthPt: number;
  };
  header: {
    heightPt: number;
    nameUppercase: boolean;
    nameAlignment: "left" | "center" | "right";
    nameTextColor: ResumeLayoutColor;
    nameRegion: "sidebar" | "main";
    nameXPt: number;
    nameYPt: number;
    /** Optional spatial hint; absent on templates produced before header-contact support. */
    contactRegion?: "header" | "sidebar" | "main";
  };
  typography: {
    namePt: number;
    sectionPt: number;
    bodyPt: number;
    nameFont: ResumeLayoutFontFamily;
    headingFont: ResumeLayoutFontFamily;
    bodyFont: ResumeLayoutFontFamily;
    nameWeight: ResumeLayoutFontWeight;
    headingWeight: ResumeLayoutFontWeight;
    bodyWeight: ResumeLayoutFontWeight;
  };
  visual: {
    contentBounds: { x: number; y: number; width: number; height: number };
    regions: ResumeLayoutVisualRegion[];
    sectionPlacements: Array<{
      section: ResumeLayoutSection;
      region: "sidebar" | "main";
      /** Optional page/vertical anchors, absent on earlier v3 templates. */
      pageNumber?: number;
      yPt?: number;
    }>;
    bodyTextColor: ResumeLayoutColor;
    headingTextColor: ResumeLayoutColor;
    bodyLineHeightRatio: number;
    paragraphGapPt: number;
    warnings: string[];
  };
};

export type ResumeLayoutTemplate = ResumeLayoutTemplateV2 | ResumeLayoutTemplateV3;

export type ResumeLayoutTextBlock = {
  text: string;
  bbox: [number, number, number, number];
  spans: Array<{
    text: string;
    bbox: [number, number, number, number];
    fontName: string;
    fontFamily: ResumeLayoutFontFamily;
    fontSizePt: number;
    weight: "normal" | "bold";
    fillColor?: ResumeLayoutColor;
  }>;
};

export type RawResumeExtraction = {
  schema_version: "1.1";
  source_file: { name: string; size_bytes: number };
  coordinate_system: "PDF points; origin at top-left";
  page: { format: "A4" | "custom"; width_pt: number; height_pt: number };
  template: {
    supported_template_id: ResumeLayoutTemplate["id"];
    detected_columns: 1 | 2;
    confidence: number;
  };
  images: { count: number; bytes_extracted: false; reused_in_output: false };
  pages: Array<{
    page_number: number;
    width_pt: number;
    height_pt: number;
    text_blocks: ResumeLayoutTextBlock[];
    drawings: {
      rectangle_count: number;
      unsupported_path_count: number;
      fill_colors: string[];
      fill_rectangles: Array<{
        bbox: [number, number, number, number];
        fill_color: string;
      }>;
      extracted_as_paths: false;
    };
  }>;
  usage: {
    ocr: false;
    source_pdf_retained: false;
    note: string;
  };
  /** Ambiguous header/footer candidates are preserved and reported here. */
  extraction_warnings?: string[];
  /** Text omitted from the resume body as high-confidence recurring page furniture. */
  excluded_furniture?: Array<{
    page_number: number;
    text: string;
    reason: "repeated_name" | "continuation_label" | "pagination";
  }>;
};

export type ResumeLayoutImportResponse = {
  templateId: string;
  template: ResumeLayoutTemplate;
  resumeText: string;
  layoutAvailable: boolean;
  layoutWarnings: string[];
  rawExtraction: RawResumeExtraction;
  detectedSections: Array<{ label: string; pageNumber: number; confidence: number }>;
  expiresAt: string;
};

export const RESUME_LAYOUT_LIMITS = {
  maximumPdfBytes: 10 * 1024 * 1024,
  maximumPages: 30,
  maximumCharacters: 80_000,
  maximumTextBlocks: 12_000,
  maximumRenderedPages: 200,
  maximumVectorRegions: 64,
  templateLifetimeMs: 24 * 60 * 60_000,
} as const;
