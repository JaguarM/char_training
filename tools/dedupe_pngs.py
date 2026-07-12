import os
import hashlib
from pathlib import Path

def get_file_hash(filepath):
    """Calculate SHA-256 hash of a file."""
    hasher = hashlib.sha256()
    with open(filepath, 'rb') as f:
        # Read the file in chunks to handle large files efficiently
        for chunk in iter(lambda: f.read(4096), b""):
            hasher.update(chunk)
    return hasher.hexdigest()

def deduplicate_pngs(directory):
    """Finds and deletes identical PNG files in the given directory."""
    print(f"Scanning directory: {directory} for identical PNGs...")
    
    seen_hashes = {}
    deleted_count = 0
    
    # Using rglob to find all pngs in the directory and any subdirectories
    for filepath in Path(directory).rglob('*.png'):
        if not filepath.is_file():
            continue
            
        file_hash = get_file_hash(filepath)
        
        if file_hash in seen_hashes:
            print(f"Deleting duplicate: {filepath}")
            print(f"  (Identical to: {seen_hashes[file_hash]})")
            try:
                os.remove(filepath)
                deleted_count += 1
            except Exception as e:
                print(f"  Error deleting {filepath}: {e}")
        else:
            seen_hashes[file_hash] = filepath
            
    print(f"\nDone! Deleted {deleted_count} duplicate PNG files.")
    print(f"Kept {len(seen_hashes)} unique PNG files.")

if __name__ == "__main__":
    # Point to the templates folder relative to this script
    templates_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")
    
    if os.path.exists(templates_dir):
        deduplicate_pngs(templates_dir)
    else:
        print(f"Error: The directory '{templates_dir}' does not exist.")
