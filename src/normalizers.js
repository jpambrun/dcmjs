import { DicomMetaDictionary } from './DicomMetaDictionary.js';
import { DerivedImage } from './derivations.js';

class Normalizer {
  constructor (datasets) {
    this.datasets = datasets; // one or more dicom-like object instances
    this.dataset = undefined; // a normalized multiframe dicom object instance
  }

  static consistentSOPClassUIDs(datasets) {
    // return sopClassUID if all exist and match, otherwise undefined
    let sopClassUID;
    datasets.forEach(function(dataset) {
      if (!dataset.SOPClassUID) {
        return(undefined);
      }
      if (!sopClassUID) {
       sopClassUID = dataset.SOPClassUID;
      }
      if (dataset.SOPClassUID !== sopClassUID) {
        console.error('inconsistent sopClassUIDs: ', dataset.SOPClassUID, sopClassUID);
        return(undefined);
      }
    });
    return(sopClassUID);
  }

  static normalizerForSOPClassUID(sopClassUID) {
    sopClassUID = sopClassUID.replace(/[^0-9.]/g,''); // TODO: clean all VRs as part of normalizing
    let toUID = DicomMetaDictionary.sopClassUIDsByName;
    let sopClassUIDMap = {};
    sopClassUIDMap[toUID.CTImage] = CTImageNormalizer;
    sopClassUIDMap[toUID.MRImage] = MRImageNormalizer;
    sopClassUIDMap[toUID.EnhancedMRImage] = EnhancedMRImageNormalizer;
    sopClassUIDMap[toUID.EnhancedUSVolume] = EnhancedUSVolumeNormalizer;
    sopClassUIDMap[toUID.PETImage] = PETImageNormalizer;
    sopClassUIDMap[toUID.EnhancedPETImage] = PETImageNormalizer;
    sopClassUIDMap[toUID.Segmentation] = SEGImageNormalizer;
    sopClassUIDMap[toUID.DeformableSpatialRegistration] = DSRNormalizer;
    return(sopClassUIDMap[sopClassUID]);
  }

  static isMultiframe(ds=this.dataset) {
    let sopClassUID = ds.SOPClassUID.replace(/[^0-9.]/g,''); // TODO: clean all VRs as part of normalizing
    let toUID = DicomMetaDictionary.sopClassUIDsByName;
    let multiframeSOPClasses = [
      toUID.EnhancedMRImage,
      toUID.EnhancedCTImage,
      toUID.EnhancedUSImage,
      toUID.EnhancedPETImage,
      toUID.Segmentation,
    ];
    return (multiframeSOPClasses.indexOf(sopClassUID) !== -1);
  }

  normalize() {
    return("No normalization defined");
  }

  static normalizeToDataset(datasets) {
    let sopClassUID = Normalizer.consistentSOPClassUIDs(datasets);
    let normalizerClass = Normalizer.normalizerForSOPClassUID(sopClassUID);
    if (!normalizerClass) {
      console.error('no normalizerClass for ', sopClassUID);
      return(undefined);
    }
    let normalizer = new normalizerClass(datasets);
    normalizer.normalize();
    return(normalizer.dataset);
  }
}

class ImageNormalizer extends Normalizer {
  normalize() {
    this.convertToMultiframe();
    this.normalizeMultiframe();
  }

  static vec3CrossProduct(a, b) {
    let ax = a[0], ay = a[1], az = a[2],
        bx = b[0], by = b[1], bz = b[2];
    let out = [];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
  }

  static vec3Subtract(a, b) {
    let out = [];
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    out[2] = a[2] - b[2];
    return out;
  }

  static vec3Dot(a, b) {
    return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
  }

  convertToMultiframe() {
    if (this.datasets.length === 1 && Normalizer.isMultiframe(this.datasets[0])) {
      // already a multiframe, so just use it
      this.dataset = this.datasets[0];
      return;
    }
    this.derivation = new DerivedImage(this.datasets);
    this.dataset = this.derivation.dataset;
    let ds = this.dataset;
    // create a new multiframe from the source datasets
    // fill in only those elements required to make a valid image
    // for volumetric processing
    let referenceDataset = this.datasets[0];
    ds.NumberOfFrames = this.datasets.length;

    // TODO: develop sets of elements to copy over in loops
    ds.SOPClassUID = referenceDataset.SOPClassUID;
    ds.Rows = referenceDataset.Rows;
    ds.Columns = referenceDataset.Columns;
    ds.BitsAllocated = referenceDataset.BitsAllocated;
    ds.PixelRepresentation = referenceDataset.PixelRepresentation;
    ds.RescaleSlope = referenceDataset.RescaleSlope || "1";
    ds.RescaleIntercept = referenceDataset.RescaleIntercept || "0";
    //ds.BurnedInAnnotation = referenceDataset.BurnedInAnnotation || "YES";

    // sort
    // https://github.com/pieper/Slicer3/blob/master/Base/GUI/Tcl/LoadVolume.tcl
    // TODO: add spacing checks:
    // https://github.com/Slicer/Slicer/blob/master/Modules/Scripted/DICOMPlugins/DICOMScalarVolumePlugin.py#L228-L250
    // TODO: put this information into the Shared and PerFrame functional groups
    let referencePosition = referenceDataset.ImagePositionPatient;
    let rowVector = referenceDataset.ImageOrientationPatient.slice(0,3);
    let columnVector = referenceDataset.ImageOrientationPatient.slice(3,6);
    let scanAxis = ImageNormalizer.vec3CrossProduct(rowVector,columnVector);
    let distanceDatasetPairs = [];
    this.datasets.forEach(function(dataset) {
      let position = dataset.ImagePositionPatient.slice();
      let positionVector = ImageNormalizer.vec3Subtract(position, referencePosition);
      let distance = ImageNormalizer.vec3Dot(positionVector, scanAxis);
      distanceDatasetPairs.push([distance, dataset]);
    });
    distanceDatasetPairs.sort(function(a,b) {
      return (b[0]-a[0]);
    });

    // assign array buffers
    if (ds.BitsAllocated !== 16) {
      console.error('Only works with 16 bit data, not ' + String(dataset.BitsAllocated));
    }
    if (referenceDataset._vrMap && !referenceDataset._vrMap.PixelData) {
      console.warn('No vr map given for pixel data, using OW');
      ds._vrMap = {'PixelData': 'OW'};
    } else {
      ds._vrMap = {'PixelData': referenceDataset._vrMap.PixelData};
    }
    let frameSize = referenceDataset.PixelData.byteLength;
    ds.PixelData = new ArrayBuffer(ds.NumberOfFrames * frameSize);
    let frame = 0;
    distanceDatasetPairs.forEach(function(pair) {
      let [distance, dataset] = pair;
      let pixels = new Uint16Array(dataset.PixelData);
      let frameView = new Uint16Array(ds.PixelData, frame * frameSize, frameSize/2);
      try {
        frameView.set(pixels);
      } catch (e) {
        if (e instanceof RangeError) {
          console.error("Error inserting pixels in PixelData");
          console.error("frameSize", frameSize);
          console.error("NumberOfFrames", ds.NumberOfFrames);
          console.error("pair", pair);
          console.error("dataset PixelData size", dataset.PixelData.length);
        }
      }
      frame++;
    });

    if (ds.NumberOfFrames < 2) {
      // TODO
      console.error('Cannot populate shared groups uniquely without multiple frames');
    }
    let [distance0, dataset0]  = distanceDatasetPairs[0];
    let [distance1, dataset1] = distanceDatasetPairs[1];

    //
    // make the functional groups
    //

    // shared

    ds.SharedFunctionalGroupsSequence = {
      PlaneOrientationSequence : {
        ImageOrientationPatient : dataset0.ImageOrientationPatient,
      },
      PixelMeasuresSequence : {
        PixelSpacing : dataset0.PixelSpacing,
        SpacingBetweenSlices : Math.abs(distance1 - distance0),
      },
    };

    // per-frame

    ds.PerFrameFunctionalGroupsSequence = [];
    distanceDatasetPairs.forEach(function(pair) {
      ds.PerFrameFunctionalGroupsSequence.push({
        PlanePositionSequence : {
          ImagePositionPatient: pair[1].ImagePositionPatient,
        },
      });
    });

    ds.ReferencedSeriesSequence = {
      SeriesInstanceUID : dataset0.SeriesInstanceUID,
      ReferencedInstance : new Array(this.datasets.length),
    };

    // copy over each datasets window/level into the per-frame groups
    // and set the referenced series uid
    let datasetIndex = 0;
    this.datasets.forEach(function(dataset) {
      ds.PerFrameFunctionalGroupsSequence[datasetIndex].FrameVOILUTSequence = {
        WindowCenter: dataset.WindowCenter,
        WindowWidth: dataset.WindowWidth,
      };
      ds.ReferencedSeriesSequence.ReferencedInstance[datasetIndex] = {
        ReferencedSOPClass: dataset.SOPClassUID,
        ReferencedSOPInstanceUID: dataset.SOPInstanceUID,
      };
      datasetIndex++;
    });

    let dimensionUID = DicomMetaDictionary.uid();
    this.dataset.DimensionOrganizationSequence = {
      DimensionOrganizationUID : dimensionUID
    };
    this.dataset.DimensionIndexSequence = [
      {
        DimensionOrganizationUID : dimensionUID,
        DimensionIndexPointer : 2097202,
        FunctionalGroupPointer : 2134291, // PlanePositionSequence
        DimensionDescriptionLabel : "ImagePositionPatient"
      },
    ];
  }

  normalizeMultiframe() {
    let ds = this.dataset;
    if (!ds.NumberOfFrames) {
      console.error("Missing number or frames not supported");
      return;
    }
    if (Number(ds.NumberOfFrames) === 1) {
      console.error("Single frame instance of multiframe class not supported");
      return;
    }
    if (!ds.PixelRepresentation) {
      // Required tag: guess signed
      ds.PixelRepresentation = 1;
    }
    if (!ds.StudyID || ds.StudyID === "") {
      // Required tag: fill in if needed
      ds.StudyID = "No Study ID";
    }

    let validLateralities = ["R", "L"];
    if (validLateralities.indexOf(ds.Laterality) === -1) {
      delete(ds.Laterality);
    }

    if (!ds.PresentationLUTShape) {
      ds.PresentationLUTShape = "IDENTITY";
    }

    if (!ds.SharedFunctionalGroupsSequence) {
      console.error('Can only process multiframe data with SharedFunctionalGroupsSequence');
    }

    // TODO: special case!
    if (ds.BodyPartExamined === "PROSTATE") {
      ds.SharedFunctionalGroupsSequence.FrameAnatomySequence = {
        AnatomicRegionSequence: {
          CodeValue: "T-9200B",
          CodingSchemeDesignator: "SRT",
          CodeMeaning: "Prostate",
        },
        FrameLaterality: "U",
      };
    }

    let rescaleIntercept = ds.RescaleIntercept || 0;
    let rescaleSlope = ds.RescaleSlope || 1;
    ds.SharedFunctionalGroupsSequence.PixelValueTransformationSequence = {
      RescaleIntercept: rescaleIntercept,
      RescaleSlope: rescaleSlope,
      RescaleType: "US",
    };

    let frameNumber = 1;
    this.datasets.forEach(dataset=>{
      let frameTime = dataset.AcquisitionDate + dataset.AcquisitionTime;
      ds.PerFrameFunctionalGroupsSequence[frameNumber-1].FrameContentSequence = {
        FrameAcquisitionDateTime: frameTime,
        FrameReferenceDateTime: frameTime,
        FrameAcquisitionDuration: 0,
        StackID: 1,
        InStackPositionNumber: frameNumber,
        DimensionIndexValues: frameNumber,
      };
      frameNumber++;
    });


    //
    // TODO: convert this to shared functional group not top level element
    //
    if (ds.WindowCenter && ds.WindowWidth) {
      // if they exist as single values, make them lists for consistency
      if (!Array.isArray(ds.WindowCenter)) {
        ds.WindowCenter = [ds.WindowCenter];
      }
      if (!Array.isArray(ds.WindowWidth)) {
        ds.WindowWidth = [ds.WindowWidth];
      }
    }
    if (!ds.WindowCenter || !ds.WindowWidth) {
      // if they don't exist, make them empty lists and try to initialize them
      ds.WindowCenter = []; // both must exist and be the same length
      ds.WindowWidth = [];
      // provide a volume-level window/level guess (mean of per-frame)
      if (ds.PerFrameFunctionalGroupsSequence) {
        let wcww = {center: 0, width: 0, count: 0};
        ds.PerFrameFunctionalGroupsSequence.forEach(function(functionalGroup) {
          if (functionalGroup.FrameVOILUT) {
            let wc = functionalGroup.FrameVOILUTSequence.WindowCenter;
            let ww = functionalGroup.FrameVOILUTSequence.WindowWidth;
            if (functionalGroup.FrameVOILUTSequence && wc && ww) {
              if (Array.isArray(wc)) {
                wc = wc[0];
              }
              if (Array.isArray(ww)) {
                ww = ww[0];
              }
              wcww.center += Number(wc);
              wcww.width += Number(ww);
              wcww.count++;
            }
          }
        });
        if (wcww.count > 0) {
          ds.WindowCenter.push(String(wcww.center / wcww.count));
          ds.WindowWidth.push(String(wcww.width / wcww.count));
        }
      }
    }
    // last gasp, pick an arbitrary default
    if (ds.WindowCenter.length === 0) { ds.WindowCenter = [300]; }
    if (ds.WindowWidth.length === 0) { ds.WindowWidth = [500]; }
  }
}

class MRImageNormalizer extends ImageNormalizer {
  normalize() {
    super.normalize();
    // TODO: provide option at export to swap in LegacyConverted UID
    let toUID = DicomMetaDictionary.sopClassUIDsByName;
    //this.dataset.SOPClassUID = "LegacyConvertedEnhancedMRImage";
    this.dataset.SOPClassUID = toUID.EnhancedMRImage;
  }

  normalizeMultiframe() {
    super.normalizeMultiframe();
    let ds = this.dataset;

    if (!ds.ImageType ||
        !ds.ImageType.constructor ||
        ds.ImageType.constructor.name != "Array" ||
        ds.ImageType.length != 4) {
      ds.ImageType = ["ORIGINAL", "PRIMARY", "OTHER", "NONE",];
    }

    ds.SharedFunctionalGroupsSequence.MRImageFrameType = {
      FrameType: ds.ImageType,
      PixelPresentation: "MONOCHROME",
      VolumetricProperties: "VOLUME",
      VolumeBasedCalculationTechnique: "NONE",
      ComplexImageComponent: "MAGNITUDE",
      AcquisitionContrast: "UNKNOWN",
    };
  }
}

class EnhancedMRImageNormalizer extends ImageNormalizer {
  normalize() {
    super.normalize();
  }
}

class EnhancedUSVolumeNormalizer extends ImageNormalizer {
  normalize() {
    super.normalize();
  }
}

class CTImageNormalizer extends ImageNormalizer {
  normalize() {
    super.normalize();
    // TODO: provide option at export to swap in LegacyConverted UID
    let toUID = DicomMetaDictionary.sopClassUIDsByName;
    //this.dataset.SOPClassUID = "LegacyConvertedEnhancedCTImage";
    this.dataset.SOPClassUID = toUID.EnhancedCTImage;
  }
}

class PETImageNormalizer extends ImageNormalizer {
  normalize() {
    super.normalize();
    // TODO: provide option at export to swap in LegacyConverted UID
    let toUID = DicomMetaDictionary.sopClassUIDsByName;
    //this.dataset.SOPClassUID = "LegacyConvertedEnhancedPETImage";
    this.dataset.SOPClassUID = toUID.EnhancedPETImage;
  }
}

class SEGImageNormalizer extends ImageNormalizer {
  normalize() {
    super.normalize();
  }
}

class DSRNormalizer extends Normalizer {
  normalize() {
    this.dataset = this.datasets[0]; // only one dataset per series and for now we assume it is normalized
  }
}

export { Normalizer };
export { ImageNormalizer };
export { MRImageNormalizer };
export { EnhancedMRImageNormalizer };
export { EnhancedUSVolumeNormalizer };
export { CTImageNormalizer };
export { PETImageNormalizer };
export { SEGImageNormalizer };
export { DSRNormalizer };
