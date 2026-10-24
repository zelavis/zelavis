// The component runtime the Platform adds to every HTML service page (`serviceUi`, built by scripts/build-service-ui.mjs):
// fuzor/ui under the `zv` brand, so a plain page writes `<zv-select>`, `<zv-dialog>`, `<zv-tabs>` and has them work.
//
// What a service page is likely to need, and no more: the rest of fuzor/ui (date pickers, colour picker, image cropper, QR
// code, tours…) would more than double the module every page downloads; a page that wants one registers it from its own
// bundle. Button, Badge, Card and Stack are left out because the service-page element library (`service-elements.js`)
// already owns `zv-button`, `zv-badge`, `zv-card` and `zv-stack`, and a page may load it beside this runtime.
import {
  defineBrand,
  registerAccordion,
  registerAvatar,
  registerCheckbox,
  registerCollapsible,
  registerCombobox,
  registerDialog,
  registerDrawer,
  registerEditable,
  registerHoverCard,
  registerListbox,
  registerMenu,
  registerNumberInput,
  registerPagination,
  registerPasswordInput,
  registerPinInput,
  registerPopover,
  registerProgress,
  registerRadioGroup,
  registerRatingGroup,
  registerScrollArea,
  registerSelect,
  registerSeparator,
  registerSlider,
  registerSteps,
  registerSwitch,
  registerTabs,
  registerTagsInput,
  registerToast,
  registerToggle,
  registerToggleGroup,
  registerTooltip,
  registerTreeView,
} from "fuzor/ui";

defineBrand("zv");
registerAccordion();
registerAvatar();
registerCheckbox();
registerCollapsible();
registerCombobox();
registerDialog();
registerDrawer();
registerEditable();
registerHoverCard();
registerListbox();
registerMenu();
registerNumberInput();
registerPagination();
registerPasswordInput();
registerPinInput();
registerPopover();
registerProgress();
registerRadioGroup();
registerRatingGroup();
registerScrollArea();
registerSelect();
registerSeparator();
registerSlider();
registerSteps();
registerSwitch();
registerTabs();
registerTagsInput();
registerToast();
registerToggle();
registerToggleGroup();
registerTooltip();
registerTreeView();
