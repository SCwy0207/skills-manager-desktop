import { AlignJustify, Rows3 } from "lucide-react";

import { useDensity, type UiDensity } from "../theme/density";
import { useI18n } from "../i18n/i18n";

const densityOptions: Array<{
  value: UiDensity;
  labelKey: string;
  descriptionKey: string;
  icon: typeof Rows3;
}> = [
  {
    value: "compact",
    labelKey: "density.compact",
    descriptionKey: "density.compact.description",
    icon: AlignJustify,
  },
  {
    value: "comfortable",
    labelKey: "density.comfortable",
    descriptionKey: "density.comfortable.description",
    icon: Rows3,
  },
];

export function DensitySwitcher() {
  const { t } = useI18n();
  const { density, setDensity } = useDensity();

  return (
    <div className="density-switcher" role="group" aria-label={t("density.group")}>
      {densityOptions.map(({ value, labelKey, descriptionKey, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={density === value}
          title={t(descriptionKey)}
          onClick={() => setDensity(value)}
        >
          <Icon size={14} aria-hidden="true" />
          <span>{t(labelKey)}</span>
        </button>
      ))}
    </div>
  );
}
