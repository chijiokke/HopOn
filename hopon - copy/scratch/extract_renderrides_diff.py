import json

transcript_path = r"C:\Users\ikehm\.gemini\antigravity\brain\aa977c1e-bf23-4302-8cde-2edfc4d11c03\.system_generated\logs\transcript_full.jsonl"

found = False
with open(transcript_path, 'r', encoding='utf-8') as f:
    for line in f:
        step = json.loads(line)
        if "tool_calls" in step:
            for tc in step["tool_calls"]:
                args = tc.get("args", {})
                args_str = str(args)
                if "index.html" in args_str and "renderRidesUI" in args_str and "replace_file_content" in tc["name"]:
                    print(f"Step {step['step_index']}: Tool {tc['name']}")
                    print("StartLine:", args.get("StartLine"), "EndLine:", args.get("EndLine"))
                    
                    with open(f"target_renderRidesUI_{step['step_index']}.txt", "w", encoding="utf-8") as out:
                        out.write(args.get("TargetContent", ""))
                    with open(f"replacement_renderRidesUI_{step['step_index']}.txt", "w", encoding="utf-8") as out:
                        out.write(args.get("ReplacementContent", ""))
                    print(f"Wrote target and replacement files for Step {step['step_index']}")
                    found = True
                    
if not found:
    print("Could not find any replace_file_content edits for renderRidesUI in the full transcript.")
