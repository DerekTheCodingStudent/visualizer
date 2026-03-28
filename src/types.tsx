// BarChart Types

export interface LegendItem {
    name: string;
    color: [number, number, number, number];
}

export interface BarData {
    x: number;
    y: number;
    w: number;
    h: number;
    label: string;
    segments: number[];
    sourceFile?: string;
}

export interface ChartDefinition {
    title?: string;
    unit?: string;
    legend: LegendItem[];
    bars: BarData[];
}

export type Orientation = "horizontal" | "vertical";

// QuadTree Types

export type Quad = {
    x: number;
    y: number;
    w: number;
    h: number;
    color?: [number, number, number, number];
};

export type Rect = { x: number; y: number; w: number; h: number };
