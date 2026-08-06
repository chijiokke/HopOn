import re

html_path = r"c:\Users\ikehm\Downloads\HopOn\index.html"
target_html_path = r"c:\Users\ikehm\Downloads\HopOn\target_step_163.txt"
target_js_path = r"c:\Users\ikehm\Downloads\HopOn\target_renderRidesUI_181.txt"

with open(html_path, 'r', encoding='utf-8') as f:
    html_content = f.read()

with open(target_html_path, 'r', encoding='utf-8') as f:
    orig_html = f.read()

with open(target_js_path, 'r', encoding='utf-8') as f:
    orig_js = f.read()

# 1. Revert HTML Block
pattern_html = r'<!-- ══════════════ RIDES ══════════════ -->\s*<div class="screen" id="screen-rides">[\s\S]*?<!-- List Container -->\s*<div class="tab-content active" id="tab-content-available" style="padding-bottom: 120px;"></div>\s*</div>'

match_html = re.search(pattern_html, html_content)
if match_html:
    print("Found HTML match!")
    # Wrap the original HTML with the comment header to keep it tidy
    replacement_html = "<!-- ══════════════ RIDES ══════════════ -->\n" + orig_html.strip()
    html_content = html_content[:match_html.start()] + replacement_html + html_content[match_html.end():]
else:
    print("Could not find HTML match using regex.")

# 2. Revert JavaScript Block
# We want to match from switchRidesFilterTab to the end of renderRidesUI.
# Let's search for "function switchRidesFilterTab" to "// ── Student Verification ──"
pattern_js = r'  function switchRidesFilterTab\(tab\) \{[\s\S]*?// ── Student Verification ──'

match_js = re.search(pattern_js, html_content)
if match_js:
    print("Found JS match!")
    # We replace from switchRidesFilterTab up to // ── Student Verification ──
    # The replacement should be just the original renderRidesUI() function, followed by the comment header
    replacement_js = orig_js.strip() + "\n\n  // ── Student Verification ──"
    html_content = html_content[:match_js.start()] + replacement_js + html_content[match_js.end():]
else:
    print("Could not find JS match using regex.")

# Write back to index.html if both succeeded or we want to apply the changes
if match_html or match_js:
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html_content)
    print("Reverted successfully!")
