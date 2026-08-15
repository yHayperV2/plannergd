c = open('index.html', 'r', encoding='utf-8').read()

# Find the actual bytes used
idx = c.find('TAB 2:')
chunk = c[idx:idx+1200]

# Build the exact needle from what we found
old_start = '    <!-- TAB 2:'
old_end = '    </div>'

# Find the exact section
start = c.find('    <!-- TAB 2:')
# Find the closing div - we need the one that closes gtab-vendas-historico
# It should be 2 </div> tags: one for section, one for gtab-vendas-historico div
# Let's find the exact content
end_marker = '    <!-- TAB 3:'
end = c.find(end_marker)
old_block = c[start:end]
print("OLD BLOCK length:", len(old_block))
print(repr(old_block[:200]))
