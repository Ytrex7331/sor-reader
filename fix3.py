with open('src/App.jsx', 'r') as f: content = f.read()
content = content.replace('{event.distanceKm.toFixed(3)}', '{formatDistanceValue(event.distanceKm, 3)}')
with open('src/App.jsx', 'w') as f: f.write(content)
