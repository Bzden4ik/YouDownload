import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
path = r'C:\Users\warfa\Downloads\YouDownLoad\src\renderer\src\globals.css'
with open(path, 'r', encoding='utf-8-sig') as f:
    content = f.read()
idx = content.find('.vp-footer')
print(repr(content[idx:idx+300]))
