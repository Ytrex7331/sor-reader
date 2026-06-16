import sys
with open('src/ReportConfigurator.jsx', 'r') as f: content = f.read()
def esc(s): return s.replace('BACKTICK', chr(96))

old_helpers = '''  const fixed = preview?.fixed || {}
  const unitsOfDistance = fixed.unitsOfDistance === 'mt' ? 'm' : 'km'
  const distanceScale = unitsOfDistance === 'm' ? 1000 : 1
  const distanceAxisLabel = BACKTICKDistance (${unitsOfDistance})BACKTICK'''
new_helpers = '''  const fixed = preview?.fixed || {}
  
  const getUnitInfo = (unitCode) => {
    switch (unitCode) {
      case 'mt': return { label: 'm', scale: 1000, decimals: 1, name: 'Meters (m)' };
      case 'ft': return { label: 'ft', scale: 3280.84, decimals: 1, name: 'Feet (ft)' };
      case 'kf': return { label: 'kft', scale: 3.28084, decimals: 3, name: 'Kilofeet (kft)' };
      case 'mi': return { label: 'mi', scale: 0.621371, decimals: 4, name: 'Miles (mi)' };
      case 'km':
      default: return { label: 'km', scale: 1, decimals: 4, name: 'Kilometers (km)' };
    }
  }
  const unitInfo = getUnitInfo(fixed.unitsOfDistance);
  const unitsOfDistance = unitInfo.label;
  const distanceScale = unitInfo.scale;
  const distanceAxisLabel = BACKTICKDistance (${unitsOfDistance})BACKTICK'''
content = content.replace(esc(old_helpers), esc(new_helpers))

old_format = '''  const formatDistanceValue = (value) => {
    if (value == null || Number.isNaN(Number(value))) return '--'
    return BACKTICK${(Number(value) * distanceScale).toFixed(unitsOfDistance === 'm' ? 1 : 4)}BACKTICK
  }'''
new_format = '''  const formatDistanceValue = (value) => {
    if (value == null || Number.isNaN(Number(value))) return '--'
    return BACKTICK${(Number(value) * distanceScale).toFixed(unitInfo.decimals)}BACKTICK
  }'''
content = content.replace(esc(old_format), esc(new_format))

old_unit_display = "{unitsOfDistance === 'm' ? 'Meters (m)' : 'Kilometers (km)'}"
new_unit_display = "{unitInfo.name}"
content = content.replace(old_unit_display, new_unit_display)

with open('src/ReportConfigurator.jsx', 'w') as f: f.write(content)
