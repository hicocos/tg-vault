export interface RequestGeneration {
    signal: AbortSignal;
    generation: number;
    isCurrent: () => boolean;
}

export class LatestRequest {
    private controller: AbortController | null = null;
    private generation = 0;

    begin(): RequestGeneration {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        const generation = ++this.generation;
        return {
            signal: controller.signal,
            generation,
            isCurrent: () => this.generation === generation && !controller.signal.aborted,
        };
    }

    cancel(): void {
        this.controller?.abort();
        this.controller = null;
        this.generation += 1;
    }
}
