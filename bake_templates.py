import os
import base64
import json
import re

STEM_TO_CHAR = { 'eq': '=', 'slash': '/', 'plus': '+', 'minus': '-' }

def stem_to_char(stem):
    base = stem.split('_')[0]
    if base in STEM_TO_CHAR:
        return STEM_TO_CHAR[base]
    if '_UPPER' in stem:
        return stem.split('_UPPER')[0]
    return base

templates_dir = 'templates'
encoded_templates = []

for filename in sorted(os.listdir(templates_dir)):
    if not filename.endswith('.png') or 'unmatched' in filename:
        continue
    stem = filename[:-4]
    char = stem_to_char(stem)
    if not char or len(char) != 1:
        continue
        
    filepath = os.path.join(templates_dir, filename)
    with open(filepath, 'rb') as f:
        b64_data = base64.b64encode(f.read()).decode('utf-8')
        
    encoded_templates.append({
        'char': char,
        'data': f"data:image/png;base64,{b64_data}"
    })

# Read batch_ocr.html
with open('batch_ocr.html', 'r', encoding='utf-8') as f:
    html = f.read()

# Create the replacement block
block = f"""// --- BAKED-IN TEMPLATES ---
const HARDCODED_TEMPLATES = {json.dumps(encoded_templates)};

(async () => {{
  setStatus('Loading baked-in templates…');
  const tasks = HARDCODED_TEMPLATES.map(t => engine._loadGray(t.data, t.char));
  const results = await Promise.all(tasks);
  engine.templates = results.filter(Boolean);
  setStatus(`${{engine.templates.length}} baked-in templates loaded`);
  tmplBtn.classList.add('active');
  if (pdfDoc) runBtn.disabled = false;
}})();
"""

# Replace exactly from the marker up to the closing </script> tag
new_html = re.sub(
    r'// --- BAKED-IN TEMPLATES ---.*?(?=</script>)',
    block.replace('\\', '\\\\'), 
    html,
    flags=re.DOTALL
)

with open('batch_ocr.html', 'w', encoding='utf-8') as f:
    f.write(new_html)

print(f"Successfully baked {len(encoded_templates)} templates into batch_ocr.html!")