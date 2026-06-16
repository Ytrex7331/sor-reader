import sys
with open('src/App.jsx', 'r') as f: content = f.read()
def esc(s): return s.replace('BACKTICK', chr(96))

content = content.replace('const dataVal = px2d(me.clientX - rect.left)\n      if (dataVal === null) return\n      posRef.current = applyRules(posRef.current, idx, dataVal, maxRef.current)', 'const dataVal = px2d(me.clientX - rect.left)\n      if (dataVal === null) return\n      posRef.current = applyRules(posRef.current, idx, dataVal / distanceScale, maxRef.current)')

content = content.replace('const px = d2px(v)', 'const px = d2px(v * distanceScale)')
content = content.replace('const px = d2px(event.distanceKm)', 'const px = d2px(event.distanceKm * distanceScale)')

with open('src/App.jsx', 'w') as f: f.write(content)
