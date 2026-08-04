import { useState } from "react";
import { TYPE_PROVIDER } from "@/types";
import { SPEECH_TO_TEXT_PROVIDERS } from "@/config";
import { useApp } from "@/contexts";
import {
  addCustomSttProvider,
  getCustomSttProviders,
  removeCustomSttProvider,
  updateCustomSttProvider,
  validateCurl,
} from "@/lib";
import {
  STT_PROVIDER_SECRET_KEY,
  removeProviderAndSecret,
  syncProviderMetadataChange,
} from "@/lib/provider-sync";
import { removeSecret } from "@/lib/storage/secure-secrets";

export function useCustomSttProviders() {
  const { loadData } = useApp();
  const [showForm, setShowForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [formData, setFormData] = useState<TYPE_PROVIDER>({
    id: "",
    responseContentPath: "",
    isCustom: true,
    curl: "",
  });

  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const handleEdit = (providerId: string) => {
    const customProviders = getCustomSttProviders();
    const provider = customProviders.find((p) => p.id === providerId);
    if (!provider) return;

    setFormData({
      ...provider,
    });
    setEditingProvider(providerId);
    setShowForm(!showForm);
    setErrors({});
  };

  const handleAutoFill = (providerId: string) => {
    const provider = SPEECH_TO_TEXT_PROVIDERS.find((p) => p.id === providerId);
    if (!provider) return;

    setFormData({
      ...provider,
      curl: provider.curl,
    });

    setErrors({});
  };

  const handleDelete = (providerId: string) => {
    setDeleteConfirm(providerId);
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;

    try {
      const success = await removeProviderAndSecret({
        providerId: deleteConfirm,
        baseKey: STT_PROVIDER_SECRET_KEY,
        removeProvider: removeCustomSttProvider,
        removeSecret,
      });
      if (success) {
        setDeleteConfirm(null);
        syncProviderMetadataChange(loadData);
      }
    } catch (error) {
      console.error("Error deleting custom provider:", error);
    }
  };

  const cancelDelete = () => {
    setDeleteConfirm(null);
  };

  const handleSave = async () => {
    // Validate form
    const newErrors: { [key: string]: string } = {};

    if (!formData.curl.trim()) {
      newErrors.curl = "Curl command is required";
    } else {
      const hasAudioVar = formData.curl.includes("{{AUDIO}}");

      if (!hasAudioVar) {
        newErrors.curl = "cURL command must contain {{AUDIO}}.";
      } else {
        const validation = validateCurl(formData.curl, []);
        if (!validation.isValid) {
          newErrors.curl = validation.message || "";
        }
      }
    }

    if (!formData.responseContentPath?.trim()) {
      newErrors.responseContentPath = "Response content path is required";
    }

    setErrors(newErrors);

    if (Object.keys(newErrors).length > 0) {
      return;
    }

    try {
      if (editingProvider) {
        // Update existing provider
        const success = updateCustomSttProvider(editingProvider, {
          curl: formData.curl,
          responseContentPath: formData.responseContentPath,
        });

        if (success) {
          setEditingProvider(null);
          setShowForm(false);
          setFormData({
            id: "",
            responseContentPath: "",
            isCustom: true,
            curl: "",
          });
          syncProviderMetadataChange(loadData);
        }
      } else {
        // Create new provider
        const newProvider = {
          curl: formData.curl,
          responseContentPath: formData.responseContentPath,
        };

        const saved = addCustomSttProvider(newProvider);
        if (saved) {
          setShowForm(false);
          setFormData({
            id: "",
            responseContentPath: "",
            isCustom: true,
            curl: "",
          });
          syncProviderMetadataChange(loadData);
        }
      }
    } catch (error) {
      console.error("Error saving custom provider:", error);
    }
  };

  return {
    errors,
    setErrors,
    showForm,
    setShowForm,
    editingProvider,
    setEditingProvider,
    deleteConfirm,
    formData,
    setFormData,
    handleSave,
    handleAutoFill,
    handleEdit,
    handleDelete,
    confirmDelete,
    cancelDelete,
  };
}
