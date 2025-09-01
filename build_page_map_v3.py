import fitz  # PyMuPDF
import json

PDF_PATH = "public/mlb/MLB_CBA_2022.pdf"
OUT_PATH = "public/mlb/page_map_v3.json"

def build_page_map():
    doc = fitz.open(PDF_PATH)
    page_map = {}

    # Loop through every page
    for i in range(len(doc)):
        page_num = i + 1  # true PDF page number (1–442)
        text = doc[i].get_text("text")

        # Look for "ARTICLE" or "ATTACHMENT" or "APPENDIX" markers
        lines = text.splitlines()
        for line in lines:
            line_stripped = line.strip()
            if line_stripped.startswith("ARTICLE "):
                key = line_stripped.split(" ")[1]  # e.g. "VI—Salaries"
                page_map[f"Article {key}"] = page_num
            elif line_stripped.startswith("ATTACHMENT "):
                key = line_stripped.split(" ")[1]
                page_map[f"Attachment {key}"] = page_num
            elif line_stripped.startswith("APPENDIX "):
                key = line_stripped.split(" ")[1]
                page_map[f"Appendix {key}"] = page_num

    with open(OUT_PATH, "w") as f:
        json.dump(page_map, f, indent=2)

    print(f"✅ Built {OUT_PATH} with {len(page_map)} entries")

if __name__ == "__main__":
    build_page_map()
