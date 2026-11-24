import { t } from "@shared/i18n";
import { useState } from "react";
import { DEFAULT_COMMIT_PREFIXES } from "@shared/preferences/commit-prefix";
import { CommitMessageEditor } from "../../components/ui/forms/CommitMessageEditor";
import {
  Checkbox,
  CheckboxControl,
  Field,
  Input,
  Radio,
  RadioCard,
  RangeField,
  SearchField,
  SegmentedControl,
  Select,
  Slider,
  Textarea,
} from "../../components/ui/index";
import { Name, Sample } from "./GallerySample";

export function GalleryForms() {
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [choice, setChoice] = useState("first");
  const [checked, setChecked] = useState(true);
  const [radio, setRadio] = useState("first");
  const [segment, setSegment] = useState("first");
  const [slider, setSlider] = useState(50);

  return (
    <>
      <Sample id="gallery-fields" title={t("settings.componentGallery.textFields")}>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Input
              aria-label={t("settings.componentGallery.exampleInput")}
              placeholder={t("settings.componentGallery.repositoryName")}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />

            <Input
              aria-label={t("settings.componentGallery.smallInput")}
              size="sm"
              placeholder={t("settings.componentGallery.compactInput")}
            />

            <Input
              aria-label={t("settings.componentGallery.invalidInput")}
              invalid
              placeholder={t("settings.componentGallery.invalidInput")}
            />

            <Input
              aria-label={t("settings.componentGallery.disabledInput")}
              disabled
              value={t("componentGallery.inputDisabled")}
              readOnly
            />

            <Name>{t("settings.componentGallery.input")}</Name>
          </div>

          <div className="space-y-2">
            <SearchField
              aria-label={t("settings.componentGallery.exampleSearch")}
              size="md"
              placeholder={t("settings.componentGallery.searchRepositories")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />

            <Field
              label={t("settings.componentGallery.field")}
              hint={t("settings.componentGallery.labelAndHintAreLinkedToTheInput")}
            >
              {(props) => (
                <Input {...props} placeholder={t("settings.componentGallery.fieldWithInput")} />
              )}
            </Field>

            <Field
              label={t("settings.componentGallery.fieldWithError")}
              error={t("settings.componentGallery.exampleValidationMessage")}
            >
              {(props) => (
                <Input {...props} invalid value={t("componentGallery.needsAttention")} readOnly />
              )}
            </Field>

            <Name>{t("settings.componentGallery.searchFieldField")}</Name>
          </div>
        </div>
      </Sample>

      <Sample id="gallery-choices" title={t("settings.componentGallery.choicesAndTextArea")}>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-3">
            <label className="block space-y-1.5 text-xs text-text-secondary">
              <span>{t("settings.componentGallery.selection")}</span>

              <Select
                className="w-full"
                aria-label={t("settings.componentGallery.exampleSelect")}
                value={choice}
                onValueChange={setChoice}
              >
                <option value="first">{t("settings.componentGallery.firstOption")}</option>
                <option value="second">{t("settings.componentGallery.secondOption")}</option>
                <option value="unavailable" disabled>
                  {t("settings.componentGallery.unavailableOption")}
                </option>
              </Select>
            </label>

            <Field
              label={t("settings.componentGallery.selectionWithError")}
              error={t("settings.componentGallery.chooseAnAvailableOption")}
            >
              {(props) => (
                <Select
                  {...props}
                  invalid
                  className="w-full"
                  value=""
                  onValueChange={() => undefined}
                >
                  <option value="" disabled>
                    {t("settings.componentGallery.chooseAnOption")}
                  </option>
                  <option value="available">
                    {t("settings.componentGallery.availableOption")}
                  </option>
                </Select>
              )}
            </Field>

            <Select
              aria-label={t("settings.componentGallery.disabledSelect")}
              disabled
              className="w-full"
              value="managed"
              onValueChange={() => undefined}
            >
              <option value="managed">{t("settings.componentGallery.managedSelection")}</option>
            </Select>

            <CommitMessageEditor
              message={message}
              onChange={setMessage}
              conventional
              prefixes={DEFAULT_COMMIT_PREFIXES}
              summaryLimit={72}
            />

            <Field
              label={t("settings.componentGallery.notesWithError")}
              error={t("settings.componentGallery.addADescriptionBeforeContinuing")}
            >
              {(props) => (
                <Textarea
                  {...props}
                  invalid
                  rows={2}
                  placeholder={t("settings.componentGallery.requiredDescription")}
                />
              )}
            </Field>

            <label className="block space-y-2 text-xs text-text-secondary">
              <span>{t("settings.componentGallery.range", { slider: slider })}</span>

              <Slider
                aria-label={t("settings.componentGallery.exampleSlider")}
                min={0}
                max={100}
                value={slider}
                onChange={(event) => setSlider(Number(event.target.value))}
                className="block w-full"
              />
            </label>

            <div className="space-y-1 text-xs text-text-secondary">
              <p>{t("settings.componentGallery.diffLayout")}</p>

              <SegmentedControl
                label={t("settings.componentGallery.exampleSegment")}
                value={segment}
                options={[
                  { value: "first", label: t("settings.componentGallery.unified") },
                  { value: "second", label: t("settings.componentGallery.sideBySide") },
                ]}
                onChange={setSegment}
              />
            </div>

            <RangeField
              label={t("settings.componentGallery.imageStrength")}
              value={slider}
              onCommit={setSlider}
            />

            <Name>
              {t("settings.componentGallery.selectTextareaSliderRangeFieldSegmentedControl")}
            </Name>
          </div>

          <div className="space-y-3">
            <Checkbox
              className="w-full"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            >
              {t("settings.componentGallery.fetchInTheBackground")}
            </Checkbox>

            <Checkbox className="w-full" disabled checked readOnly>
              {t("settings.componentGallery.managedByYourWorkspace")}
            </Checkbox>

            <label className="flex items-center gap-2 text-sm">
              <CheckboxControl
                checked={checked}
                onChange={(event) => setChecked(event.target.checked)}
              />

              {t("settings.componentGallery.checkboxControl")}
            </label>

            <div
              role="radiogroup"
              aria-label={t("settings.componentGallery.exampleRadioGroup")}
              className="flex flex-wrap gap-4 text-sm"
            >
              {["first", "second"].map((value) => (
                <label key={value} className="flex items-center gap-2">
                  <Radio
                    name="gallery-radio"
                    checked={radio === value}
                    onChange={() => setRadio(value)}
                  />

                  {value}
                </label>
              ))}
            </div>

            <div
              role="radiogroup"
              aria-label={t("settings.componentGallery.radioCardExample")}
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              {["first", "second"].map((value) => (
                <RadioCard
                  key={value}
                  name="gallery-card"
                  value={value}
                  checked={radio === value}
                  onChange={setRadio}
                >
                  <span
                    aria-hidden="true"
                    className="radio-control"
                    data-checked={radio === value}
                  />

                  <span className="text-sm">
                    {value === "first"
                      ? t("settings.componentGallery.comfortable")
                      : t("settings.componentGallery.compact")}
                  </span>
                </RadioCard>
              ))}

              <RadioCard
                name="gallery-card"
                value="disabled"
                checked={false}
                disabled
                onChange={setRadio}
              >
                <span className="text-sm">{t("settings.componentGallery.unavailable")}</span>
              </RadioCard>
            </div>

            <Name>{t("settings.componentGallery.checkboxCheckboxControlRadioRadioCard")}</Name>
          </div>
        </div>
      </Sample>
    </>
  );
}
