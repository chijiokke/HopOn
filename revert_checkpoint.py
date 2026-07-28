#!/usr/bin/env python3
import subprocess
import sys
import os
import datetime

def find_git():
    try:
        res = subprocess.run(["git", "--version"], capture_output=True, text=True)
        if res.returncode == 0:
            return "git"
    except Exception:
        pass
    
    appdata = os.environ.get("LOCALAPPDATA", r"C:\Users\ikehm\AppData\Local")
    github_desktop_git = os.path.join(appdata, "GitHubDesktop", "app-3.5.12", "resources", "app", "git", "cmd", "git.exe")
    if os.path.exists(github_desktop_git):
        return github_desktop_git
    
    for root, dirs, files in os.walk(os.path.join(appdata, "GitHubDesktop")):
        if "git.exe" in files:
            return os.path.join(root, "git.exe")
            
    return "git"

def main():
    git_bin = find_git()
    print(f"📌 Using Git binary: {git_bin}")
    
    now_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_branch = f"backup_wip_{now_str}"
    
    repo_dir = os.path.dirname(os.path.abspath(__file__))
    
    print("\n📦 Step 1: Creating safety backup branch of current state...")
    try:
        subprocess.run([git_bin, "checkout", "-b", backup_branch], cwd=repo_dir, check=True)
        subprocess.run([git_bin, "add", "-A"], cwd=repo_dir, check=True)
        subprocess.run([git_bin, "commit", "-m", f"Automated backup before reverting to stable-checkpoint ({now_str})"], cwd=repo_dir)
        print(f"✅ Backup saved to branch: {backup_branch}")
    except Exception as e:
        print(f"⚠️ Warning during backup creation: {e}")

    print("\n🔄 Step 2: Switching to main branch...")
    subprocess.run([git_bin, "checkout", "main"], cwd=repo_dir, check=True)

    print("\n⏪ Step 3: Reverting codebase to 'stable-checkpoint' (6:38 PM, Jul 27, 2026)...")
    subprocess.run([git_bin, "reset", "--hard", "stable-checkpoint"], cwd=repo_dir, check=True)

    print("\n✨ SUCCESS! Codebase reverted back to stable checkpoint (6:38 PM, Jul 27, 2026).")

if __name__ == "__main__":
    main()
