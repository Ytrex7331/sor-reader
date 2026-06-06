import os
import sys
import matplotlib.pyplot as plt
import otdrparser

def select_file():
    """Opens a native system file dialog to select the OTDR file."""
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()  # Hide the main root window
        file_path = filedialog.askopenfilename(
            title="Select an OTDR (.sor) File",
            filetypes=[("OTDR files", "*.sor"), ("All files", "*.*")]
        )
        return file_path
    except Exception:
        # Fallback to standard console input if tkinter/GUI isn't available
        return input("Enter the full path to your .sor file: ").strip()

def extract_trace_points(blocks):
    """
    Safely navigates the dictionary structure returned by otdrparser 
    to extract the list of (distance, dBm) coordinates.
    """
    # 1. Target the standard Telcordia 'DataPts' key
    datapts = blocks.get('DataPts')
    
    # 2. Case-insensitive fallback lookup
    if not datapts:
        for k, v in blocks.items():
            if k.lower() == 'datapts':
                datapts = v
                break
                
    if datapts:
        # If the block itself is the list of coordinate pairs
        if isinstance(datapts, list):
            return datapts
        # If the block is an inner dictionary, look for common list keys
        if isinstance(datapts, dict):
            for key in ['data_points', 'points', 'data', 'trace_data']:
                if key in datapts and isinstance(datapts[key], list):
                    return datapts[key]
            # Scan any list inside DataPts that contains pairs
            for val in datapts.values():
                if isinstance(val, list) and len(val) > 0 and isinstance(val[0], (list, tuple)) and len(val[0]) == 2:
                    return val

    # 3. Global deep-scan across all blocks as a ultimate fallback
    for v in blocks.values():
        if isinstance(v, list) and len(v) > 0 and isinstance(v[0], (list, tuple)) and len(v[0]) == 2:
            return v
        if isinstance(v, dict):
            for sub_v in v.values():
                if isinstance(sub_v, list) and len(sub_v) > 0 and isinstance(sub_v[0], (list, tuple)) and len(sub_v[0]) == 2:
                    return sub_v
                    
    return None

def main():
    # If a file path is provided as a command-line argument, use it
    if len(sys.argv) > 1:
        file_path = sys.argv[1]
    else:
        print("No file argument provided. Opening file selector...")
        file_path = select_file()
        
    if not file_path or not os.path.exists(file_path):
        print(f"Error: File path '{file_path}' is invalid or empty.")
        return

    print(f"Parsing: {os.path.basename(file_path)}...")
    
    try:
        # otdrparser requires a binary stream ('rb')
        with open(file_path, 'rb') as fp:
            blocks = otdrparser.parse2(fp)
    except Exception as e:
        print(f"Failed to parse the file: {e}")
        return

    # Extract the curve coordinate sets
    points = extract_trace_points(blocks)
    
    if not points:
        print("Error: Could not find valid trace data points in this file.")
        print("Available blocks extracted:", list(blocks.keys()))
        return

    print(f"Successfully parsed {len(points)} data points.")
    
    # Split coordinates into X (Distance) and Y (dBm Signal Level)
    distances = [pt[0] for pt in points]
    dbm_values = [pt[1] for pt in points]
    
    # Create the plot
    plt.figure(figsize=(11, 6))
    plt.plot(distances, dbm_values, label='Fibre Trace', color='#007acc', linewidth=1.2)
    
    # Style the graph
    plt.title(f"OTDR Trace Profile: {os.path.basename(file_path)}", fontsize=14, fontweight='bold')
    plt.xlabel("Distance", fontsize=12)
    plt.ylabel("Reflectance / Loss (dBm)", fontsize=12)
    plt.grid(True, which='both', linestyle='--', alpha=0.6)
    plt.legend(loc='upper right')
    
    # Render interactive plot window (allows zooming and panning)
    print("Displaying trace profile window. Close the window to exit the script.")
    plt.show()

if __name__ == "__main__":
    main()