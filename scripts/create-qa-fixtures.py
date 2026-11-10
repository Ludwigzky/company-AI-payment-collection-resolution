"""Create clearly fictional, non-sensitive upload fixtures for browser QA."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

destination = Path(__file__).resolve().parents[2] / 'debt-recovery-artifacts' / 'qa'
for folder in ('case-a', 'case-b'):
    (destination / folder).mkdir(parents=True, exist_ok=True)
(destination / 'case-a' / '项目说明.txt').write_text('仅供验收的虚构项目A资料\n项目代号：ALPHA-ONLY\n待核对款项：328000元\n设备运行不稳定，双方尚未确认故障原因。\n拟定维修复验节点：2026年11月18日，尚待双方确认。\n此资料仅属于项目A，不得作为其他项目的材料。\n', encoding='utf-8')
(destination / 'case-b' / '项目说明.txt').write_text('仅供验收的虚构项目B资料\n项目代号：BETA-ONLY\n一般货款：78000元\n双方需要核查交付及对账记录，不包含任何设备维修事实。\n此资料仅属于项目B，不得作为其他项目的材料。\n', encoding='utf-8')
image = Image.new('RGB', (1200, 820), 'white')
draw = ImageDraw.Draw(image)
font_path = 'C:/Windows/Fonts/msyh.ttc'
title = ImageFont.truetype(font_path, 38)
body = ImageFont.truetype(font_path, 29)
draw.rectangle((50, 45, 1150, 765), outline='#334155', width=3)
draw.text((85, 75), '虚构验收资料 · 项目 A 设备服务单', font=title, fill='#111827')
lines = ['仅供软件测试，无真实企业信息', '项目代号：ALPHA-ONLY', '设备问题：电机温度异常，运行后频繁报警', '现场检查：故障原因未确认，需双方共同排查', '拟议复验日期：2026 年 11 月 18 日（待确认）', '签字栏：客户尚未签字，验收结果待核实', '提示：本图片只属于项目 A，不适用于其他项目']
for index, line in enumerate(lines):
    draw.text((85, 160 + index * 77), line, font=body, fill='#1f2937')
image.save(destination / 'case-a' / '设备服务单.png')
print(str(destination))
