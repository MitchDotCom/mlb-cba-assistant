import json
import re

# Load the page-by-page text (generated already from PDF)
with open("cba_pages.json", "r") as f:
    cba_pages = json.load(f)

# Regex patterns — catch ARTICLE, APPENDIX, ATTACHMENT anywhere in the line
article_re = re.compile(r"\bARTICLE\s+[IVXLCDM]+\b", re.IGNORECASE)
appendix_re = re.compile(r"\bAPPENDIX\s+[A-Z]+\b", re.IGNORECASE)
attachment_re = re.compile(r"\bATTACHMENT\s+\d+\b", re.IGNORECASE)

entries = []

for page in cba_pages:
    page_num = page["page"]
    for line in page["text"].splitlines():
        line = line.strip()
        if not line:
            continue
        if article_re.search(line) or appendix_re.search(line) or attachment_re.search(line):
            entries.append((line, page_num))

# Sort them in order of appearance
entries = sorted(entries, key=lambda x: x[1])

# Build start/end ranges
page_map = {}
for i, (line, start_page) in enumerate(entries):
    end_page = cba_pages[-1]["page"] if i == len(entries) - 1 else entries[i+1][1] - 1

    # Normalize key
    parts = line.split()
    if parts[0].upper() == "ARTICLE":
        key = f"Article {parts[1]}"
    elif parts[0].upper() == "APPENDIX":
        key = f"Appendix {parts[1]}"
    elif parts[0].upper() == "ATTACHMENT":
        key = f"Attachment {parts[1]}"
    else:
        key = line

    page_map[key] = {
        "title": line,
        "start": start_page,
        "end": end_page
    }

# Save output
with open("page_map.json", "w") as f:
    json.dump(page_map, f, indent=2)

print(f"Built page_map.json with {len(page_map)} entries")
