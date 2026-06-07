#!/usr/bin/env python3
"""
Check if our modifications are in the compiled JavaScript code
"""

import os


def check_compiled_js():
    """Check if our modifications are in the compiled JS"""
    
    print("🔍 Checking compiled JavaScript for our modifications...")
    
    # Check the compiled main process file
    main_js_path = "c:\\Users\\thomas.leberre\\Repositories\\WorkPilot-AI\\apps\\frontend\\out\\main\\index.js"
    
    if not os.path.exists(main_js_path):
        print("❌ Compiled main.js not found")
        return False
    
    try:
        with open(main_js_path, encoding='utf-8') as f:
            content = f.read()
        
        # Check for our key modifications in the compiled code
        checks = [
            ("FastAPI backend URL", "http://localhost:9000/providers/usage/copilot" in content),
            ("Copilot getUsageForProvider", "getUsageForProvider" in content and "copilot" in content),
            ("IPC handler with providerName", "providerName?" in content),
            ("Copilot special case", "providerName === 'copilot'" in content),
            ("Backend response handling", "INSUFFICIENT_PERMISSIONS" in content)
        ]
        
        print("\n📋 Compiled code checks:")
        all_good = True
        for check_name, result in checks:
            status = "✅" if result else "❌"
            print(f"   {status} {check_name}")
            if not result:
                all_good = False
        
        if all_good:
            print("\n✅ All modifications are present in the compiled code")
            print("💡 The issue might be that the Electron process hasn't restarted")
            print("🔄 Solution: Force quit and restart the Electron application")
        else:
            print("\n❌ Some modifications are missing from the compiled code")
            print("🔧 The build may not have included our changes")
        
        return all_good
        
    except Exception as e:
        print(f"❌ Error checking compiled code: {e}")
        return False

def check_process_restart():
    """Check if we need to restart the process"""
    
    print("\n🔄 Checking if process restart is needed...")
    
    # Check if there are any Electron processes running
    try:
        import subprocess
        result = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq electron.exe'],
                              capture_output=True, text=True)
        
        if 'electron.exe' in result.stdout:
            print("⚠️  Electron process is still running")
            print("💡 The process needs to be completely restarted to load new code")
            print("🔧 Solution: Force quit the application and restart it")
            return True
        else:
            print("✅ No Electron process running")
            return False
            
    except Exception as e:
        print(f"❌ Error checking processes: {e}")
        return False

if __name__ == "__main__":
    compiled_ok = check_compiled_js()
    process_running = check_process_restart()
    
    if compiled_ok and process_running:
        print("\n🎯 SOLUTION:")
        print("1. Force quit the Electron application completely")
        print("2. Restart the application")
        print("3. Test again with the debug script")
    elif compiled_ok and not process_running:
        print("\n✅ Everything looks good - try restarting the application")
    else:
        print("\n❌ There are issues with the compiled code")
