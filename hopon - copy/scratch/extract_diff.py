import json

transcript_path = r"C:\Users\ikehm\.gemini\antigravity\brain\aa977c1e-bf23-4302-8cde-2edfc4d11c03\.system_generated\logs\transcript_full.jsonl"

found = False
with open(transcript_path, 'r', encoding='utf-8') as f:
    for line in f:
        step = json.loads(line)
        if step.get("step_index") == 163:
            print("FOUND STEP 163")
            found = True
            for tc in step.get("tool_calls", []):
                args = tc.get("args", {})
                print("TargetContent length:", len(args.get("TargetContent", "")))
                print("ReplacementContent length:", len(args.get("ReplacementContent", "")))
                
                # Write target and replacement to files so we can inspect them fully
                with open("target_step_163.txt", "w", encoding="utf-8") as out:
                    out.write(args.get("TargetContent", ""))
                with open("replacement_step_163.txt", "w", encoding="utf-8") as out:
                    out.write(args.get("ReplacementContent", ""))
                print("Wrote target_step_163.txt and replacement_step_163.txt")
            break

if not found:
    print("Could not find Step 163 in transcript_full.jsonl")
