import re

html_path = r"c:\Users\ikehm\Downloads\HopOn\index.html"

with open(html_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Define the pattern to find the duplicate else block and extra closing brace.
# We look for the closing brace, followed by } else { document.getElementById('splash')... and ending at the second else block's closing brace.
pattern = r"""\s*\}\s*\}\s*else\s*\{\s*document\.getElementById\('splash'\)\.classList\.remove\('hidden'\);\s*showLogin\(\);\s*//\s*Unsubscribe\s*from\s*all\s*active\s*listeners[\s\S]*?activeChatOtherUserId\s*=\s*null;\s*\}"""

match = re.search(pattern, content)
if match:
    print("Found the target duplicate block!")
    print(f"Match start: {match.start()}, end: {match.end()}")
    # We replace it with just one closing brace for the first 'else' block.
    # Note: we want the first 'else' block to close, so we replace with:
    # \n      }
    replacement = "\n      }"
    new_content = content[:match.start()] + replacement + content[match.end():]
    
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print("Replacement successful!")
else:
    print("Could not find the target duplicate block using regex. Let's print the surrounding area to inspect.")
    # Fallback search by literal substring
    # Let's find: activeChatOtherUserId = null;\n        }\n      } else {
    idx = content.find("activeChatOtherUserId = null;\n        }\n      } else {")
    if idx == -1:
        # try with other spacings
        idx = content.find("activeChatOtherUserId = null;\n         }\n       } else {")
    if idx == -1:
        # let's try to search for the console.error lines
        idx = content.find("activeChatOtherUserId = null;\n         }\n       } else {")
        
    print("Found by literal:", idx)
