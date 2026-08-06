import json

transcript_path = r"C:\Users\ikehm\.gemini\antigravity\brain\aa977c1e-bf23-4302-8cde-2edfc4d11c03\.system_generated\logs\transcript.jsonl"

with open(transcript_path, 'r', encoding='utf-8') as f:
    for line in f:
        step = json.loads(line)
        if "tool_calls" in step:
            for tc in step["tool_calls"]:
                args = tc.get("args", {})
                args_str = str(args)
                if "index.html" in args_str and ("Find or offer a ride today" in args_str or "screen-rides" in args_str or "Find rides, cargo" in args_str):
                    print(f"Step {step['step_index']}: Tool {tc['name']}")
                    print(json.dumps(args, indent=2))
                    print("=" * 60)
