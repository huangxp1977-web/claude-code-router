import { useState } from "react";
import { Pencil, Trash2, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Provider } from "@/types";

interface ProviderListProps {
  providers: Provider[];
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}

export function ProviderList({ providers, onEdit, onRemove, onReorder }: ProviderListProps) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Handle case where providers might be null or undefined
  if (!providers || !Array.isArray(providers)) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-center rounded-md border bg-card p-8 text-muted-foreground">
          No providers configured
        </div>
      </div>
    );
  }

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    if (!onReorder) return;
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.currentTarget.style.opacity = "0.5";
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    if (!onReorder || draggedIndex === null || draggedIndex === index) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDragEnd = (e: React.DragEvent<HTMLDivElement>) => {
    if (!onReorder || draggedIndex === null) return;
    e.currentTarget.style.opacity = "1";
    setDragOverIndex(null);
    setDraggedIndex(null);
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    if (!onReorder || draggedIndex === null || draggedIndex === toIndex) return;
    e.preventDefault();
    onReorder(draggedIndex, toIndex);
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="space-y-3">
      {providers.map((provider, index) => {
        // Handle case where individual provider might be null or undefined
        if (!provider) {
          return (
            <div
              key={index}
              className="flex items-start justify-between rounded-md border bg-card p-4 transition-all hover:shadow-md animate-slide-in hover:scale-[1.01]"
              draggable={!!onReorder}
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragLeave={handleDragLeave}
              onDragEnd={handleDragEnd}
              onDrop={(e) => handleDrop(e, index)}
            >
              <div className="flex-1 space-y-1.5">
                <p className="text-md font-semibold text-foreground">Invalid Provider</p>
                <p className="text-sm text-muted-foreground">Provider data is missing</p>
              </div>
              <div className="ml-4 flex flex-shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onEdit(index)}
                  className="transition-all-ease hover:scale-110"
                  disabled
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="destructive"
                  size="icon"
                  onClick={() => onRemove(index)}
                  className="transition-all duration-200 hover:scale-110"
                >
                  <Trash2 className="h-4 w-4 text-current transition-colors duration-200" />
                </Button>
              </div>
            </div>
          );
        }

        // Handle case where provider.name might be null or undefined
        const providerName = provider.name || "Unnamed Provider";

        // Handle case where provider.api_base_url might be null or undefined
        const apiBaseUrl = provider.api_base_url || "No API URL";

        // Handle case where provider.models might be null or undefined
        const models = Array.isArray(provider.models) ? provider.models : [];

        const isDragging = draggedIndex === index;
        const isDragOver = dragOverIndex === index && draggedIndex !== null && draggedIndex !== index;

        return (
          <div
            key={index}
            className={cn(
              "flex items-start justify-between rounded-md border bg-card p-4 transition-all hover:shadow-md animate-slide-in hover:scale-[1.01]",
              isDragging && "opacity-50 scale-[1.02] shadow-lg",
              isDragOver && "border-dashed border-primary bg-primary/5",
              onReorder && "cursor-grab active:cursor-grabbing"
            )}
            draggable={!!onReorder}
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragLeave={handleDragLeave}
            onDragEnd={handleDragEnd}
            onDrop={(e) => handleDrop(e, index)}
          >
            {/* Drag Handle */}
            {onReorder && (
              <div
                className="flex-shrink-0 mr-3 flex items-center justify-center text-muted-foreground hover:text-muted-foreground cursor-grab active:cursor-grabbing select-none"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <GripVertical className="h-5 w-5" />
              </div>
            )}

            <div className="flex-1 space-y-1.5">
              <p className="text-md font-semibold text-foreground">{providerName}</p>
              <p className="text-sm text-muted-foreground">{apiBaseUrl}</p>
              <div className="flex flex-wrap gap-2 pt-2">
                {models.map((model, modelIndex) => (
                  // Handle case where model might be null or undefined
                  <Badge key={modelIndex} variant="outline" className="font-normal transition-all-ease hover:scale-105">
                    {model || "Unnamed Model"}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="ml-4 flex flex-shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onEdit(index)}
                className="transition-all-ease hover:scale-110"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="destructive"
                size="icon"
                onClick={() => onRemove(index)}
                className="transition-all duration-200 hover:scale-110"
              >
                <Trash2 className="h-4 w-4 text-current transition-colors duration-200" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}