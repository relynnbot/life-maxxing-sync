import re

with open('lifemaxxing-v1.html', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace("return 'MORNING';", "return 'Morning';")
content = content.replace("return 'AFTERNOON';", "return 'Afternoon';")
content = content.replace("return 'EVENING';", "return 'Evening';")

content = content.replace(">RELYNN</span>", ">Relynn</span>")

content = content.replace(
    "return new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();",
    "return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });"
)

content = content.replace("GRIND<span style=\"color:var(--accent);\">.</span>", "GRIND")
content = content.replace("HEALTH<span style=\"color:var(--accent-green);\">.</span>", "HEALTH")
content = content.replace("CAREER<span style=\"color:var(--accent-purple);\">.</span>", "CAREER")

content = content.replace('font-weight: 900', 'font-weight: 700')

with open('lifemaxxing-v1.html', 'w', encoding='utf-8') as f:
    f.write(content)
