import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useConfig } from "./ConfigProvider";
import { ProviderList } from "./ProviderList";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { X, Trash2, Plus, Eye, EyeOff, Search, XCircle, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { ComboInput } from "@/components/ui/combo-input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { Toast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import type { Provider } from "@/types";

interface ProviderType extends Provider {}

// Router fields that may reference provider models
const ROUTER_FIELDS = ['default', 'background', 'think', 'longContext', 'webSearch', 'image'] as const;

// Transformers that accept user-configurable parameters
const TRANSFORMERS_WITH_PARAMS = ['anthropic', 'customparams', 'maxtoken', 'openrouter', 'reasoning', 'sampling', 'vercel'];

// Fixed parameter presets for transformers — keys are pre-filled and disabled
const TRANSFORMERS_FIXED_PARAMS: Record<string, string[]> = {
  maxtoken: ['max_tokens'],
  reasoning: ['enable'],
  anthropic: ['UseBearer'],
  sampling: ['max_tokens', 'temperature', 'top_p', 'top_k', 'repetition_penalty'],
};

/**
 * Clean up Router references when models are removed from a provider or a provider is deleted.
 * Handles both string (single model) and array (multi-model rotation) Router field values.
 */
function cleanRouterReferences(
  router: any,
  providerName: string,
  removedModels: string[]
): Record<string, any> {
  if (!router) return {};

  const cleanedRouter = { ...router };
  const specsToRemove = removedModels.map(m => `${providerName},${m}`);

  for (const field of ROUTER_FIELDS) {
    const value = cleanedRouter[field];
    if (!value) continue;

    if (typeof value === 'string') {
      // Single model string: clear if it matches any removed spec
      if (specsToRemove.includes(value)) {
        cleanedRouter[field] = '';
      }
    } else if (Array.isArray(value)) {
      // Multi-model array: filter out all removed specs
      cleanedRouter[field] = value.filter((m: string) => !specsToRemove.includes(m));
    }
  }

  return cleanedRouter;
}

const autoConvertValue = (value: string): string | number | boolean => {
  if (typeof value !== 'string' || value.trim() === '') return value;
  
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  
  return value;
};

export function Providers() {
  const { t } = useTranslation();
  const { config, setConfig } = useConfig();
  const [editingProviderIndex, setEditingProviderIndex] = useState<number | null>(null);
  const [deletingProviderIndex, setDeletingProviderIndex] = useState<number | null>(null);
  const [hasFetchedModels, setHasFetchedModels] = useState<Record<number, boolean>>({});
  const [providerParamInputs, setProviderParamInputs] = useState<Record<string, {name: string, value: string}>>({});
  const [modelParamInputs, setModelParamInputs] = useState<Record<string, {name: string, value: string}>>({});
  const [availableTransformers, setAvailableTransformers] = useState<{name: string; endpoint: string | null;}[]>([]);
  const [editingProviderData, setEditingProviderData] = useState<ProviderType | null>(null);
  const [isNewProvider, setIsNewProvider] = useState<boolean>(false);
  const [providerTemplates, setProviderTemplates] = useState<ProviderType[]>([]);
  const [showApiKey, setShowApiKey] = useState<Record<number, boolean>>({});
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const comboInputRef = useRef<HTMLInputElement>(null);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [modelSelectOpen, setModelSelectOpen] = useState(false);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  // Drag-and-drop state for model badges
  const [draggedModelIndex, setDraggedModelIndex] = useState<number | null>(null);
  const [dragOverModelIndex, setDragOverModelIndex] = useState<number | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'warning' } | null>(null);

  useEffect(() => {
    const fetchProviderTemplates = async () => {
      // Built-in templates that are always available
      const builtinTemplates: ProviderType[] = [
        {
          name: "sensenova",
          api_base_url: "https://token.sensenova.cn/v1/chat/completions",
          api_key: "",
          models: ["sensenova-6.7-flash-lite", "deepseek-v4-flash"],
        },
        {
          name: "Google",
          api_base_url: "https://generativelanguage.googleapis.com/v1beta/models/",
          api_key: "",
          models: ["gemini-3-flash-preview", "gemini-2.5-flash"],
        },
        {
          name: "xiaomimimo",
          api_base_url: "https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages",
          api_key: "",
          models: ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-pro", "mimo-v2-omni"],
        },
      ];

      try {
        const response = await fetch('https://pub-0dc3e1677e894f07bbea11b17a29e032.r2.dev/providers.json');
        if (response.ok) {
          const data = await response.json();
          const builtinNames = new Set(builtinTemplates.map(t => t.name.toLowerCase()));
          const remoteTemplates = (data || []).filter((t: ProviderType) => !builtinNames.has(t.name.toLowerCase()));
          setProviderTemplates([...builtinTemplates, ...remoteTemplates]);
        } else {
          setProviderTemplates(builtinTemplates);
        }
      } catch (error) {
        console.error('Failed to fetch provider templates:', error);
        setProviderTemplates(builtinTemplates);
      }
    };

    fetchProviderTemplates();
  }, []);

  // Fetch available transformers when component mounts
  useEffect(() => {
    const fetchTransformers = async () => {
      try {
        const response = await api.get<{transformers: {name: string; endpoint: string | null;}[]}>('/transformers');
        setAvailableTransformers(response.transformers);
      } catch (error) {
        console.error('Failed to fetch transformers:', error);
      }
    };

    fetchTransformers();
  }, []);

  // Handle case where config is null or undefined
  if (!config) {
    return (
      <Card className="flex h-full flex-col rounded-lg border shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between border-b p-4">
          <CardTitle className="text-lg">{t("providers.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex-grow flex items-center justify-center p-4">
          <div className="text-gray-500">Loading providers configuration...</div>
        </CardContent>
      </Card>
    );
  }

  // Validate config.Providers to ensure it's an array
  const validProviders = Array.isArray(config.Providers) ? config.Providers : [];


  const handleAddProvider = () => {
    const newProvider: ProviderType = { name: "", api_base_url: "", api_key: "", models: [] };
    setEditingProviderIndex(config.Providers.length);
    setEditingProviderData(newProvider);
    setIsNewProvider(true);
    // Reset API key visibility and error when adding new provider
    setShowApiKey(prev => ({
      ...prev,
      [config.Providers.length]: false
    }));
    setApiKeyError(null);
    setNameError(null);
  };

  const handleEditProvider = (index: number) => {
    // Find the actual index in the original providers array
    const actualIndex = validProviders.indexOf(filteredProviders[index]);
    const provider = config.Providers[actualIndex];
    setEditingProviderIndex(actualIndex);
    setEditingProviderData(JSON.parse(JSON.stringify(provider))); // 深拷贝
    setIsNewProvider(false);
    // Reset API key visibility and error when opening edit dialog
    setShowApiKey(prev => ({
      ...prev,
      [actualIndex]: false
    }));
    setApiKeyError(null);
    setNameError(null);
  };

  const handleSaveProvider = () => {
    if (!editingProviderData) return;
    
    // Validate name
    if (!editingProviderData.name || editingProviderData.name.trim() === '') {
      setNameError(t("providers.name_required"));
      return;
    }
    
    // Check for duplicate names (case-insensitive)
    const trimmedName = editingProviderData.name.trim();
    const isDuplicate = config.Providers.some((provider, index) => {
      // For edit mode, skip checking the current provider being edited
      if (!isNewProvider && index === editingProviderIndex) {
        return false;
      }
      return provider.name.toLowerCase() === trimmedName.toLowerCase();
    });
    
    if (isDuplicate) {
      setNameError(t("providers.name_duplicate"));
      return;
    }
    
    // Validate API key
    if (!editingProviderData.api_key || editingProviderData.api_key.trim() === '') {
      setApiKeyError(t("providers.api_key_required"));
      return;
    }
    
    // Clear errors if validation passes
    setApiKeyError(null);
    setNameError(null);
    
    if (editingProviderIndex !== null && editingProviderData) {
      const newProviders = [...config.Providers];
      let updatedRouter = config.Router;

      if (isNewProvider) {
        newProviders.push(editingProviderData);
      } else {
        // Detect removed models and clean Router references
        const oldProvider = config.Providers[editingProviderIndex];
        const oldModels: string[] = oldProvider?.models || [];
        const newModels: string[] = editingProviderData.models || [];
        const removedModels = oldModels.filter(m => !newModels.includes(m));

        if (removedModels.length > 0) {
          updatedRouter = cleanRouterReferences(config.Router, editingProviderData.name, removedModels) as any;
        }

        // Also clean up model-specific transformer configs for removed models
        if (editingProviderData.transformer) {
          const cleanedTransformer = { ...editingProviderData.transformer };
          for (const removedModel of removedModels) {
            delete cleanedTransformer[removedModel];
          }
          editingProviderData.transformer = cleanedTransformer;
        }

        newProviders[editingProviderIndex] = editingProviderData;
      }
      setConfig({ ...config, Providers: newProviders, Router: updatedRouter });
    }
    // Reset API key visibility for this provider
    if (editingProviderIndex !== null) {
      setShowApiKey(prev => {
        const newState = { ...prev };
        delete newState[editingProviderIndex];
        return newState;
      });
    }
    setEditingProviderIndex(null);
    setEditingProviderData(null);
    setIsNewProvider(false);
  };

  const handleCancelAddProvider = () => {
    // Reset fetched models state for this provider
    if (editingProviderIndex !== null) {
      setHasFetchedModels(prev => {
        const newState = { ...prev };
        delete newState[editingProviderIndex];
        return newState;
      });
      // Reset API key visibility for this provider
      setShowApiKey(prev => {
        const newState = { ...prev };
        delete newState[editingProviderIndex];
        return newState;
      });
    }
    setEditingProviderIndex(null);
    setEditingProviderData(null);
    setIsNewProvider(false);
    setApiKeyError(null);
    setNameError(null);
    setFetchedModels([]);
    setSelectedModels(new Set());
    setModelSelectOpen(false);
  };

  // Handle deletion by setting the correct index in the state
  const handleSetDeletingProviderIndex = (filteredIndex: number) => {
    setDeletingProviderIndex(filteredIndex);
  };

  // Handle deletion by passing the filtered index to get the actual index in the original array
  const handleRemoveProvider = (filteredIndex: number) => {
    // Find the actual index in the original providers array
    const actualIndex = validProviders.indexOf(filteredProviders[filteredIndex]);
    const removedProvider = config.Providers[actualIndex];
    const newProviders = [...config.Providers];
    newProviders.splice(actualIndex, 1);

    // Clean Router references for all models of the deleted provider
    let updatedRouter = config.Router;
    if (removedProvider?.models?.length > 0) {
      updatedRouter = cleanRouterReferences(config.Router, removedProvider.name, removedProvider.models) as any;
    }

    setConfig({ ...config, Providers: newProviders, Router: updatedRouter });
    setDeletingProviderIndex(null);
  };

  const handleProviderChange = (_index: number, field: string, value: string) => {
    if (editingProviderData) {
      const updatedProvider = { ...editingProviderData, [field]: value };
      setEditingProviderData(updatedProvider);
    }
  };

  const handleProviderTransformerChange = (_index: number, transformerPath: string) => {
    if (!transformerPath || !editingProviderData) return; // Don't add empty transformers
    
    const updatedProvider = { ...editingProviderData };
    
    if (!updatedProvider.transformer) {
      updatedProvider.transformer = { use: [] };
    }
    
    // Add transformer to the use array
    updatedProvider.transformer.use = [...updatedProvider.transformer.use, transformerPath];
    setEditingProviderData(updatedProvider);
  };

  const removeProviderTransformerAtIndex = (_index: number, transformerIndex: number) => {
    if (!editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    if (updatedProvider.transformer) {
      const newUseArray = [...updatedProvider.transformer.use];
      newUseArray.splice(transformerIndex, 1);
      updatedProvider.transformer.use = newUseArray;
      
      // If use array is now empty and no other properties, remove transformer entirely
      if (newUseArray.length === 0 && Object.keys(updatedProvider.transformer).length === 1) {
        delete updatedProvider.transformer;
      }
    }
    
    setEditingProviderData(updatedProvider);
  };

  const handleModelTransformerChange = (_providerIndex: number, model: string, transformerPath: string) => {
    if (!transformerPath || !editingProviderData) return; // Don't add empty transformers
    
    const updatedProvider = { ...editingProviderData };
    
    if (!updatedProvider.transformer) {
      updatedProvider.transformer = { use: [] };
    }
    
    // Initialize model transformer if it doesn't exist
    if (!updatedProvider.transformer[model]) {
      updatedProvider.transformer[model] = { use: [] };
    }
    
    // Add transformer to the use array
    updatedProvider.transformer[model].use = [...updatedProvider.transformer[model].use, transformerPath];
    setEditingProviderData(updatedProvider);
  };

  const removeModelTransformerAtIndex = (_providerIndex: number, model: string, transformerIndex: number) => {
    if (!editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    if (updatedProvider.transformer && updatedProvider.transformer[model]) {
      const newUseArray = [...updatedProvider.transformer[model].use];
      newUseArray.splice(transformerIndex, 1);
      updatedProvider.transformer[model].use = newUseArray;
      
      // If use array is now empty and no other properties, remove model transformer entirely
      if (newUseArray.length === 0 && Object.keys(updatedProvider.transformer[model]).length === 1) {
        delete updatedProvider.transformer[model];
      }
    }
    
    setEditingProviderData(updatedProvider);
  };


  const addProviderTransformerParameter = (_providerIndex: number, transformerIndex: number, paramName: string, paramValue: string) => {
    if (!editingProviderData) return;
    
    const convertedValue = autoConvertValue(paramValue);
    const updatedProvider = { ...editingProviderData };
    
    if (!updatedProvider.transformer) {
      updatedProvider.transformer = { use: [] };
    }
    
    // Add parameter to the specified transformer in use array
    if (updatedProvider.transformer.use && updatedProvider.transformer.use.length > transformerIndex) {
      const targetTransformer = updatedProvider.transformer.use[transformerIndex];
      
      // If it's already an array with parameters, update it
      if (Array.isArray(targetTransformer)) {
        const transformerArray = [...targetTransformer];
        // Check if the second element is an object (parameters object)
        if (transformerArray.length > 1 && typeof transformerArray[1] === 'object' && transformerArray[1] !== null) {
          // Update the existing parameters object
          const existingParams = transformerArray[1] as Record<string, unknown>;
          const paramsObj: Record<string, unknown> = { ...existingParams, [paramName]: convertedValue };
          transformerArray[1] = paramsObj;
        } else if (transformerArray.length > 1) {
          // If there are other elements, add the parameters object
          const paramsObj = { [paramName]: convertedValue };
          transformerArray.splice(1, transformerArray.length - 1, paramsObj);
        } else {
          // Add a new parameters object
          const paramsObj = { [paramName]: convertedValue };
          transformerArray.push(paramsObj);
        }
        
        updatedProvider.transformer.use[transformerIndex] = transformerArray as string | (string | Record<string, unknown> | { max_tokens: number })[];
      } else {
        // Convert to array format with parameters
        const paramsObj = { [paramName]: convertedValue };
        updatedProvider.transformer.use[transformerIndex] = [targetTransformer as string, paramsObj];
      }
    }
    
    setEditingProviderData(updatedProvider);
  };


  const removeProviderTransformerParameterAtIndex = (_providerIndex: number, transformerIndex: number, paramName: string) => {
    if (!editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    if (!updatedProvider.transformer?.use || updatedProvider.transformer.use.length <= transformerIndex) {
      return;
    }
    
    const targetTransformer = updatedProvider.transformer.use[transformerIndex];
    if (Array.isArray(targetTransformer) && targetTransformer.length > 1) {
      const transformerArray = [...targetTransformer];
      // Check if the second element is an object (parameters object)
      if (typeof transformerArray[1] === 'object' && transformerArray[1] !== null) {
        const paramsObj = { ...(transformerArray[1] as Record<string, unknown>) };
        delete paramsObj[paramName];
        
        // If the parameters object is now empty, remove it
        if (Object.keys(paramsObj).length === 0) {
          transformerArray.splice(1, 1);
        } else {
          transformerArray[1] = paramsObj;
        }
        
        updatedProvider.transformer.use[transformerIndex] = transformerArray;
        setEditingProviderData(updatedProvider);
      }
    }
  };

  const addModelTransformerParameter = (_providerIndex: number, model: string, transformerIndex: number, paramName: string, paramValue: string) => {
    if (!editingProviderData) return;
    
    const convertedValue = autoConvertValue(paramValue);
    const updatedProvider = { ...editingProviderData };
    
    if (!updatedProvider.transformer) {
      updatedProvider.transformer = { use: [] };
    }
    
    if (!updatedProvider.transformer[model]) {
      updatedProvider.transformer[model] = { use: [] };
    }
    
    // Add parameter to the specified transformer in use array
    if (updatedProvider.transformer[model].use && updatedProvider.transformer[model].use.length > transformerIndex) {
      const targetTransformer = updatedProvider.transformer[model].use[transformerIndex];
      
      // If it's already an array with parameters, update it
      if (Array.isArray(targetTransformer)) {
        const transformerArray = [...targetTransformer];
        // Check if the second element is an object (parameters object)
        if (transformerArray.length > 1 && typeof transformerArray[1] === 'object' && transformerArray[1] !== null) {
          // Update the existing parameters object
          const existingParams = transformerArray[1] as Record<string, unknown>;
          const paramsObj: Record<string, unknown> = { ...existingParams, [paramName]: convertedValue };
          transformerArray[1] = paramsObj;
        } else if (transformerArray.length > 1) {
          // If there are other elements, add the parameters object
          const paramsObj = { [paramName]: convertedValue };
          transformerArray.splice(1, transformerArray.length - 1, paramsObj);
        } else {
          // Add a new parameters object
          const paramsObj = { [paramName]: convertedValue };
          transformerArray.push(paramsObj);
        }
        
        updatedProvider.transformer[model].use[transformerIndex] = transformerArray as string | (string | Record<string, unknown> | { max_tokens: number })[];
      } else {
        // Convert to array format with parameters
        const paramsObj = { [paramName]: convertedValue };
        updatedProvider.transformer[model].use[transformerIndex] = [targetTransformer as string, paramsObj];
      }
    }
    
    setEditingProviderData(updatedProvider);
  };


  const removeModelTransformerParameterAtIndex = (_providerIndex: number, model: string, transformerIndex: number, paramName: string) => {
    if (!editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    if (!updatedProvider.transformer?.[model]?.use || updatedProvider.transformer[model].use.length <= transformerIndex) {
      return;
    }
    
    const targetTransformer = updatedProvider.transformer[model].use[transformerIndex];
    if (Array.isArray(targetTransformer) && targetTransformer.length > 1) {
      const transformerArray = [...targetTransformer];
      // Check if the second element is an object (parameters object)
      if (typeof transformerArray[1] === 'object' && transformerArray[1] !== null) {
        const paramsObj = { ...(transformerArray[1] as Record<string, unknown>) };
        delete paramsObj[paramName];
        
        // If the parameters object is now empty, remove it
        if (Object.keys(paramsObj).length === 0) {
          transformerArray.splice(1, 1);
        } else {
          transformerArray[1] = paramsObj;
        }
        
        updatedProvider.transformer[model].use[transformerIndex] = transformerArray;
        setEditingProviderData(updatedProvider);
      }
    }
  };

  const handleAddModel = (_index: number, model: string) => {
    if (!model.trim() || !editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    // Handle case where provider.models might be null or undefined
    const models = Array.isArray(updatedProvider.models) ? [...updatedProvider.models] : [];
    
    // Check if model already exists
    if (!models.includes(model.trim())) {
      models.push(model.trim());
      updatedProvider.models = models;
      setEditingProviderData(updatedProvider);
    }
  };

    const handleTemplateImport = (templateName: string) => {
    if (!templateName) return;
    const selectedTemplate = providerTemplates.find(p => p.name.toLowerCase() === templateName.toLowerCase());
    if (selectedTemplate) {
      const currentName = editingProviderData?.name;
      const newProviderData = JSON.parse(JSON.stringify(selectedTemplate));

      if (!isNewProvider && currentName) {
        newProviderData.name = currentName;
      }

      setEditingProviderData(newProviderData as ProviderType);
    }
  };

  const handleRemoveModel = (_providerIndex: number, modelIndex: number) => {
    if (!editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    // Handle case where provider.models might be null or undefined
    const models = Array.isArray(updatedProvider.models) ? [...updatedProvider.models] : [];
    
    // Handle case where modelIndex might be out of bounds
    if (modelIndex >= 0 && modelIndex < models.length) {
      const removedModel = models[modelIndex];
      models.splice(modelIndex, 1);
      updatedProvider.models = models;
      
      // Clean up transformer config for the removed model
      if (updatedProvider.transformer && updatedProvider.transformer[removedModel]) {
        delete updatedProvider.transformer[removedModel];
        
        // If transformer object becomes completely empty, we can delete it
        if (Object.keys(updatedProvider.transformer).length === 0) {
          delete updatedProvider.transformer;
        }
      }
      
      setEditingProviderData(updatedProvider);
    }
  };

  const fetchAvailableModels = async () => {
    if (!editingProvider) return;
    setIsFetchingModels(true);
    try {
      // Determine transformer name from provider config
      const transformerName = editingProvider.transformer?.use?.[0];
      const result = await api.fetchProviderModels(
        editingProvider.api_base_url,
        editingProvider.api_key,
        typeof transformerName === "string" ? transformerName : undefined
      );
      if (result.error) {
        setToast({ message: `${t("providers.fetch_models_failed")}: ${result.error}`, type: 'error' });
        return;
      }
      setFetchedModels(result.models || []);
      setSelectedModels(new Set(editingProvider.models || []));
      if (editingProviderIndex !== null) {
        setHasFetchedModels(prev => ({ ...prev, [editingProviderIndex]: true }));
      }
    } catch (err: any) {
      setToast({ message: `${t("providers.fetch_models_failed")}: ${err?.message}`, type: 'error' });
    } finally {
      setIsFetchingModels(false);
    }
  };

  const handleAddSelectedModels = () => {
    if (!editingProvider || !editingProviderData) return;
    const newModels = [...(editingProviderData.models || [])];
    for (const model of selectedModels) {
      if (!newModels.includes(model)) {
        newModels.push(model);
      }
    }
    setEditingProviderData({ ...editingProviderData, models: newModels });
    setModelSelectOpen(false);
  };

  const handleReorderModels = (fromIndex: number, toIndex: number) => {
    if (!editingProviderData || fromIndex === toIndex) return;
    const models = [...(editingProviderData.models || [])];
    const [moved] = models.splice(fromIndex, 1);
    models.splice(toIndex, 0, moved);
    setEditingProviderData({ ...editingProviderData, models });
  };

  const editingProvider = editingProviderData || (editingProviderIndex !== null ? validProviders[editingProviderIndex] : null);

  // Filter providers based on search term
  const filteredProviders = validProviders.filter(provider => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    // Check provider name and URL
    if (
      (provider.name && provider.name.toLowerCase().includes(term)) ||
      (provider.api_base_url && provider.api_base_url.toLowerCase().includes(term))
    ) {
      return true;
    }
    // Check models
    if (provider.models && Array.isArray(provider.models)) {
      return provider.models.some(model => 
        model && model.toLowerCase().includes(term)
      );
    }
    return false;
  });

  return (
    <>
    {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    <Card className="flex h-full flex-col rounded-lg border shadow-sm">
      <CardHeader className="flex flex-col border-b p-4 gap-3">
        <div className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">{t("providers.title")} <span className="text-sm font-normal text-gray-500">({filteredProviders.length}/{validProviders.length})</span></CardTitle>
          <Button onClick={handleAddProvider}>{t("providers.add")}</Button>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <Input
              placeholder={t("providers.search")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8"
            />
          </div>
          {searchTerm && (
            <Button 
              variant="ghost" 
              size="icon"
              onClick={() => setSearchTerm("")}
            >
              <XCircle className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-grow overflow-y-auto p-4">
        <ProviderList
          providers={filteredProviders}
          onEdit={handleEditProvider}
          onRemove={handleSetDeletingProviderIndex}
        />
      </CardContent>

      {/* Edit Dialog */}
      <Dialog open={editingProviderIndex !== null} onOpenChange={(open) => {
        if (!open) {
          handleCancelAddProvider();
        }
      }}>
        <DialogContent className="max-h-[80vh] flex flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("providers.edit")}</DialogTitle>
          </DialogHeader>
          {editingProvider && editingProviderIndex !== null && (
            <div className="space-y-4 p-4 overflow-y-auto flex-grow">
              {providerTemplates.length > 0 && (
                <div className="space-y-2">
                  <Label>{t("providers.import_from_template")}</Label>
                  <Combobox
                    options={providerTemplates.map(p => ({ label: p.name, value: p.name }))}
                    value=""
                    onChange={handleTemplateImport}
                    placeholder={t("providers.select_template")}
                    emptyPlaceholder={t("providers.no_templates_found")}
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="name">{t("providers.name")}</Label>
                <Input 
                  id="name" 
                  value={editingProvider.name || ''} 
                  onChange={(e) => {
                    handleProviderChange(editingProviderIndex, 'name', e.target.value);
                    // Clear name error when user starts typing
                    if (nameError) {
                      setNameError(null);
                    }
                  }}
                  className={nameError ? "border-red-500" : ""}
                />
                {nameError && (
                  <p className="text-sm text-red-500">{nameError}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="api_base_url">{t("providers.api_base_url")}</Label>
                <Input id="api_base_url" value={editingProvider.api_base_url || ''} onChange={(e) => handleProviderChange(editingProviderIndex, 'api_base_url', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="api_key">{t("providers.api_key")}</Label>
                <div className="relative">
                  <Input 
                    id="api_key" 
                    type={showApiKey[editingProviderIndex || 0] ? "text" : "password"} 
                    value={editingProvider.api_key || ''} 
                    onChange={(e) => handleProviderChange(editingProviderIndex, 'api_key', e.target.value)} 
                    className={apiKeyError ? "border-red-500" : ""}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-2 top-1/2 transform -translate-y-1/2 h-8 w-8"
                    onClick={() => {
                      const index = editingProviderIndex || 0;
                      setShowApiKey(prev => ({
                        ...prev,
                        [index]: !prev[index]
                      }));
                    }}
                  >
                    {showApiKey[editingProviderIndex || 0] ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                {apiKeyError && (
                  <p className="text-sm text-red-500">{apiKeyError}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="models">{t("providers.models")}</Label>
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Input
                        id="models"
                        placeholder={t("providers.models_placeholder")}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && e.currentTarget.value.trim() && editingProviderIndex !== null) {
                            handleAddModel(editingProviderIndex, e.currentTarget.value);
                            e.currentTarget.value = '';
                          }
                        }}
                      />
                    </div>
                    <Button
                      onClick={() => {
                        const input = document.getElementById('models') as HTMLInputElement;
                        if (input && input.value.trim() && editingProviderIndex !== null) {
                          handleAddModel(editingProviderIndex, input.value);
                          input.value = '';
                        }
                      }}
                    >
                      {t("providers.add_model")}
                    </Button>
                    <Button
                      onClick={fetchAvailableModels}
                      disabled={isFetchingModels}
                      variant="outline"
                    >
                      {isFetchingModels ? (
                        <><Loader2 className="mr-1 h-4 w-4 animate-spin" />{t("providers.fetching_models")}</>
                      ) : t("providers.fetch_available_models")}
                    </Button>
                  </div>
                  {fetchedModels.length > 0 && (
                    <Popover open={modelSelectOpen} onOpenChange={setModelSelectOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-start text-muted-foreground">
                          <Search className="mr-2 h-4 w-4" />
                          {t("providers.select_from_available")}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                        <Command>
                          <CommandInput placeholder={t("providers.models_placeholder")} />
                          <CommandList className="max-h-64">
                            <CommandEmpty>{t("providers.no_models_fetched")}</CommandEmpty>
                            <CommandGroup>
                              {fetchedModels.map((model) => (
                                <CommandItem
                                  key={model}
                                  value={model}
                                  onSelect={() => {
                                    setSelectedModels(prev => {
                                      const next = new Set(prev);
                                      if (next.has(model)) next.delete(model);
                                      else next.add(model);
                                      return next;
                                    });
                                  }}
                                  className="flex items-center gap-2"
                                >
                                  <Checkbox
                                    checked={selectedModels.has(model)}
                                    onCheckedChange={() => {}}
                                    className="pointer-events-none"
                                  />
                                  <span>{model}</span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                          <div className="border-t p-2">
                            <Button size="sm" className="w-full" onClick={handleAddSelectedModels}>
                              {t("providers.add_selected")} ({selectedModels.size})
                            </Button>
                          </div>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  )}
                  <div className="flex flex-wrap gap-2 pt-2">
                    {(editingProvider.models || []).map((model: string, modelIndex: number) => (
                      <Badge
                        key={model}
                        variant="outline"
                        className={cn(
                          "font-normal flex items-center gap-1 cursor-move select-none transition-all",
                          draggedModelIndex === modelIndex && "opacity-40 scale-95 border-dashed",
                          dragOverModelIndex === modelIndex && "border-blue-400 bg-blue-50"
                        )}
                        draggable
                        onDragStart={() => setDraggedModelIndex(modelIndex)}
                        onDragOver={(e) => {
                          e.preventDefault();
                          if (draggedModelIndex !== null && draggedModelIndex !== modelIndex) {
                            setDragOverModelIndex(modelIndex);
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (draggedModelIndex !== null && draggedModelIndex !== modelIndex) {
                            handleReorderModels(draggedModelIndex, modelIndex);
                          }
                          setDraggedModelIndex(null);
                          setDragOverModelIndex(null);
                        }}
                        onDragEnd={() => {
                          setDraggedModelIndex(null);
                          setDragOverModelIndex(null);
                        }}
                      >
                        {model}
                        <button
                          type="button"
                          className="ml-1 rounded-full hover:bg-gray-200"
                          onClick={(e) => {
                            e.stopPropagation();
                            editingProviderIndex !== null && handleRemoveModel(editingProviderIndex, modelIndex);
                          }}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
              
              {/* Provider Transformer Selection */}
              <div className="space-y-2">
                <Label>{t("providers.provider_transformer")}</Label>
                
                {/* Add new transformer */}
                <div className="flex gap-2">
                  <Combobox
                    options={availableTransformers.map(t => ({
                      label: t.name,
                      value: t.name
                    }))}
                    value=""
                    onChange={(value) => {
                      if (editingProviderIndex !== null) {
                        handleProviderTransformerChange(editingProviderIndex, value);
                      }
                    }}
                    placeholder={t("providers.select_transformer")}
                    emptyPlaceholder={t("providers.no_transformers")}
                  />
                </div>
                
                {/* Display existing transformers */}
                {editingProvider.transformer?.use && editingProvider.transformer.use.length > 0 && (
                  <div className="space-y-2 mt-2">
                    <div className="text-sm font-medium text-gray-700">{t("providers.selected_transformers")}</div>
                    {editingProvider.transformer.use.map((transformer: string | (string | Record<string, unknown> | { max_tokens: number })[], transformerIndex: number) => {
                      const transformerName = typeof transformer === 'string' ? transformer : Array.isArray(transformer) ? String(transformer[0]) : String(transformer);
                      const existingParams = Array.isArray(transformer) && transformer.length > 1 && typeof transformer[1] === 'object' && transformer[1] !== null ? transformer[1] as Record<string, unknown> : {};
                      const showProviderParams = TRANSFORMERS_WITH_PARAMS.includes(transformerName.toLowerCase()) || Object.keys(existingParams).length > 0;
                      const providerAllowedKeys = TRANSFORMERS_FIXED_PARAMS[transformerName.toLowerCase()];
                      const providerUnconfiguredKeys = providerAllowedKeys ? providerAllowedKeys.filter(k => !(k in existingParams)) : [];
                      const providerHideInput = providerAllowedKeys && providerUnconfiguredKeys.length === 0;
                      const providerPrefilledName = providerUnconfiguredKeys.length > 0 ? providerUnconfiguredKeys[0] : "";
                      return (
                      <div key={transformerIndex} className="border-2 border-slate-400 shadow-sm bg-white rounded-md p-3">
                        <div className="flex gap-2 items-center mb-2">
                          <div className="flex-1 bg-gray-50 rounded p-2 text-sm">
                            {typeof transformer === 'string' ? transformer : Array.isArray(transformer) ? String(transformer[0]) : String(transformer)}
                          </div>
                          <Button 
                            variant="outline" 
                            size="icon"
                            onClick={() => {
                              if (editingProviderIndex !== null) {
                                removeProviderTransformerAtIndex(editingProviderIndex, transformerIndex);
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        
                        {/* Transformer-specific Parameters */}
                        {showProviderParams && <div className="mt-2 space-y-2">
                          <Label className="text-sm">{t("providers.transformer_parameters")}</Label>
                          <div className="space-y-2 mt-1">
                            {!providerHideInput && (
                            <div className="flex gap-2">
                              <Input
                                placeholder={t("providers.parameter_name")}
                                value={providerPrefilledName || providerParamInputs[`provider-${editingProviderIndex}-transformer-${transformerIndex}`]?.name || ""}
                                disabled={!!providerPrefilledName}
                                onChange={(e) => {
                                  if (!providerPrefilledName) {
                                    const key = `provider-${editingProviderIndex}-transformer-${transformerIndex}`;
                                    setProviderParamInputs(prev => ({
                                      ...prev,
                                      [key]: {
                                        ...prev[key] || {name: "", value: ""},
                                        name: e.target.value
                                      }
                                    }));
                                  }
                                }}
                              />
                              <Input
                                placeholder={t("providers.parameter_value")}
                                value={providerParamInputs[`provider-${editingProviderIndex}-transformer-${transformerIndex}`]?.value || ""}
                                onChange={(e) => {
                                  const key = `provider-${editingProviderIndex}-transformer-${transformerIndex}`;
                                  setProviderParamInputs(prev => ({
                                    ...prev,
                                    [key]: {
                                      ...prev[key] || {name: "", value: ""},
                                      value: e.target.value
                                    }
                                  }));
                                }}
                              />
                              <Button
                                size="sm"
                                onClick={() => {
                                  if (editingProviderIndex !== null) {
                                    const key = `provider-${editingProviderIndex}-transformer-${transformerIndex}`;
                                    const paramInput = providerParamInputs[key];
                                    const paramName = providerPrefilledName || paramInput?.name;
                                    const paramValue = paramInput?.value;
                                    if (paramName && paramValue) {
                                      addProviderTransformerParameter(editingProviderIndex, transformerIndex, paramName, paramValue);
                                      setProviderParamInputs(prev => ({
                                        ...prev,
                                        [key]: {name: "", value: ""}
                                      }));
                                    }
                                  }
                                }}
                              >
                                <Plus className="h-4 w-4" />
                              </Button>
                            </div>
                            )}

                            {/* Display existing parameters for this transformer */}
                            {(() => {
                              // Get parameters for this specific transformer
                              if (!editingProvider.transformer?.use || editingProvider.transformer.use.length <= transformerIndex) {
                                return null;
                              }
                              
                              const targetTransformer = editingProvider.transformer.use[transformerIndex];
                              let params = {};
                              
                              if (Array.isArray(targetTransformer) && targetTransformer.length > 1) {
                                // Check if the second element is an object (parameters object)
                                if (typeof targetTransformer[1] === 'object' && targetTransformer[1] !== null) {
                                  params = targetTransformer[1] as Record<string, unknown>;
                                }
                              }
                              
                              return Object.keys(params).length > 0 ? (
                                <div className="space-y-1">
                                  {Object.entries(params).map(([key, value]) => (
                                    <div key={key} className="flex items-center justify-between bg-slate-100/70 border border-slate-300 rounded p-2">
                                      <div className="text-sm">
                                        <span className="font-medium">{key}:</span> {String(value)}
                                      </div>
                                      <Button 
                                        variant="ghost" 
                                        size="sm"
                                        className="h-6 w-6 p-0"
                                        onClick={() => {
                                          if (editingProviderIndex !== null) {
                                            // We need a function to remove parameters from a specific transformer
                                            removeProviderTransformerParameterAtIndex(editingProviderIndex, transformerIndex, key);
                                          }
                                        }}
                                      >
                                        <X className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  ))}
                                </div>
                              ) : null;
                            })()}
                          </div>
                        </div>}
                      </div>
                    );
                    })}
                  </div>
                )}
              </div>
              
              {/* Model-specific Transformers */}
              {editingProvider.models && editingProvider.models.length > 0 && (
                <div className="space-y-2">
                  <Label>{t("providers.model_transformers")}</Label>
                  <div className="space-y-3">
                    {(editingProvider.models || []).map((model: string, modelIndex: number) => (
                      <div key={modelIndex} className="border border-slate-400 bg-slate-50/50 rounded-lg p-4 mb-4 shadow-sm">
                        <div className="font-medium text-sm mb-2 text-slate-800">{model}</div>
                        {/* Add new transformer */}
                        <div className="flex gap-2">
                          <div className="flex-1 flex gap-2">
                            <Combobox
                              options={availableTransformers.map(t => ({
                                label: t.name,
                                value: t.name
                              }))}
                              value=""
                              onChange={(value) => {
                                if (editingProviderIndex !== null) {
                                  handleModelTransformerChange(editingProviderIndex, model, value);
                                }
                              }}
                              placeholder={t("providers.select_transformer")}
                              emptyPlaceholder={t("providers.no_transformers")}
                            />
                          </div>
                        </div>
                        
                        {/* Display existing transformers */}
                        {editingProvider.transformer?.[model]?.use && editingProvider.transformer[model].use.length > 0 && (
                          <div className="space-y-2 mt-2">
                            <div className="text-sm font-medium text-gray-700">{t("providers.selected_transformers")}</div>
                            {editingProvider.transformer[model].use.map((transformer: string | (string | Record<string, unknown> | { max_tokens: number })[], transformerIndex: number) => {
                              const modelTransformerName = typeof transformer === 'string' ? transformer : Array.isArray(transformer) ? String(transformer[0]) : String(transformer);
                              const modelExistingParams = Array.isArray(transformer) && transformer.length > 1 && typeof transformer[1] === 'object' && transformer[1] !== null ? transformer[1] as Record<string, unknown> : {};
                              const showModelParams = TRANSFORMERS_WITH_PARAMS.includes(modelTransformerName.toLowerCase()) || Object.keys(modelExistingParams).length > 0;
                              const modelAllowedKeys = TRANSFORMERS_FIXED_PARAMS[modelTransformerName.toLowerCase()];
                              const modelUnconfiguredKeys = modelAllowedKeys ? modelAllowedKeys.filter(k => !(k in modelExistingParams)) : [];
                              const modelHideInput = modelAllowedKeys && modelUnconfiguredKeys.length === 0;
                              const modelPrefilledName = modelUnconfiguredKeys.length > 0 ? modelUnconfiguredKeys[0] : "";
                              return (
                              <div key={transformerIndex} className="border-2 border-slate-400 shadow-sm bg-white rounded-md p-3">
                                <div className="flex gap-2 items-center mb-2">
                                  <div className="flex-1 bg-gray-50 rounded p-2 text-sm">
                                    {typeof transformer === 'string' ? transformer : Array.isArray(transformer) ? String(transformer[0]) : String(transformer)}
                                  </div>
                                  <Button 
                                    variant="outline" 
                                    size="icon"
                                    onClick={() => {
                                      if (editingProviderIndex !== null) {
                                        removeModelTransformerAtIndex(editingProviderIndex, model, transformerIndex);
                                      }
                                    }}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                                
                                {/* Transformer-specific Parameters */}
                                {showModelParams && <div className="mt-2 space-y-2">
                                  <Label className="text-sm">{t("providers.transformer_parameters")}</Label>
                                  <div className="space-y-2 mt-1">
                                    {!modelHideInput && (
                                    <div className="flex gap-2">
                                      <Input
                                        placeholder={t("providers.parameter_name")}
                                        value={modelPrefilledName || modelParamInputs[`model-${editingProviderIndex}-${model}-transformer-${transformerIndex}`]?.name || ""}
                                        disabled={!!modelPrefilledName}
                                        onChange={(e) => {
                                          if (!modelPrefilledName) {
                                            const key = `model-${editingProviderIndex}-${model}-transformer-${transformerIndex}`;
                                            setModelParamInputs(prev => ({
                                              ...prev,
                                              [key]: {
                                                ...prev[key] || {name: "", value: ""},
                                                name: e.target.value
                                              }
                                            }));
                                          }
                                        }}
                                      />
                                      <Input
                                        placeholder={t("providers.parameter_value")}
                                        value={modelParamInputs[`model-${editingProviderIndex}-${model}-transformer-${transformerIndex}`]?.value || ""}
                                        onChange={(e) => {
                                          const key = `model-${editingProviderIndex}-${model}-transformer-${transformerIndex}`;
                                          setModelParamInputs(prev => ({
                                            ...prev,
                                            [key]: {
                                              ...prev[key] || {name: "", value: ""},
                                              value: e.target.value
                                            }
                                          }));
                                        }}
                                      />
                                      <Button
                                        size="sm"
                                        onClick={() => {
                                          if (editingProviderIndex !== null) {
                                            const key = `model-${editingProviderIndex}-${model}-transformer-${transformerIndex}`;
                                            const paramInput = modelParamInputs[key];
                                            const paramName = modelPrefilledName || paramInput?.name;
                                            const paramValue = paramInput?.value;
                                            if (paramName && paramValue) {
                                              addModelTransformerParameter(editingProviderIndex, model, transformerIndex, paramName, paramValue);
                                              setModelParamInputs(prev => ({
                                                ...prev,
                                                [key]: {name: "", value: ""}
                                              }));
                                            }
                                          }
                                        }}
                                      >
                                        <Plus className="h-4 w-4" />
                                      </Button>
                                    </div>
                                    )}
                                    
                                    {/* Display existing parameters for this transformer */}
                                    {(() => {
                                      // Get parameters for this specific transformer
                                      if (!editingProvider.transformer?.[model]?.use || editingProvider.transformer[model].use.length <= transformerIndex) {
                                        return null;
                                      }
                                      
                                      const targetTransformer = editingProvider.transformer[model].use[transformerIndex];
                                      let params = {};
                                      
                                      if (Array.isArray(targetTransformer) && targetTransformer.length > 1) {
                                        // Check if the second element is an object (parameters object)
                                        if (typeof targetTransformer[1] === 'object' && targetTransformer[1] !== null) {
                                          params = targetTransformer[1] as Record<string, unknown>;
                                        }
                                      }
                                      
                                      return Object.keys(params).length > 0 ? (
                                        <div className="space-y-1">
                                          {Object.entries(params).map(([key, value]) => (
                                            <div key={key} className="flex items-center justify-between bg-slate-100/70 border border-slate-300 rounded p-2">
                                              <div className="text-sm">
                                                <span className="font-medium">{key}:</span> {String(value)}
                                              </div>
                                              <Button 
                                                variant="ghost" 
                                                size="sm"
                                                className="h-6 w-6 p-0"
                                                onClick={() => {
                                                  if (editingProviderIndex !== null) {
                                                    // We need a function to remove parameters from a specific transformer
                                                    removeModelTransformerParameterAtIndex(editingProviderIndex, model, transformerIndex, key);
                                                  }
                                                }}
                                              >
                                                <X className="h-3 w-3" />
                                              </Button>
                                            </div>
                                          ))}
                                        </div>
                                      ) : null;
                                    })()}
                                  </div>
                                </div>}
                              </div>
                            );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
            </div>
          )}
          <div className="space-y-3 mt-auto">
            <div className="flex justify-end gap-2">
              {/* <Button 
                variant="outline" 
                onClick={() => editingProvider && testConnectivity(editingProvider)}
                disabled={isTestingConnectivity || !editingProvider}
              >
                <Wifi className="mr-2 h-4 w-4" />
                {isTestingConnectivity ? t("providers.testing") : t("providers.test_connectivity")}
              </Button> */}
              <Button onClick={handleSaveProvider}>{t("app.save")}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deletingProviderIndex !== null} onOpenChange={() => setDeletingProviderIndex(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("providers.delete")}</DialogTitle>
            <DialogDescription>
              {t("providers.delete_provider_confirm")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingProviderIndex(null)}>{t("providers.cancel")}</Button>
            <Button variant="destructive" onClick={() => deletingProviderIndex !== null && handleRemoveProvider(deletingProviderIndex)}>{t("providers.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
    </>
  );
}
